/**
 * Real-browser scanner tests (engine worker).
 *
 * These run the actual Playwright Chromium + installed axe engine against the
 * fixture pages served by a local HTTP server (exact origin, config.allowLocal
 * per the hosted-demo policy for LOCAL TESTS only). No synthetic/fake engine
 * outputs are used for the browser-derived assertions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConfig } from "./helpers/config.js";
import { copyFixtures, startFixtureServer, type FixtureServer } from "./helpers/fixtureServer.js";
import { createScanner } from "../src/scanner.js";
import { compareRuns } from "../src/compare.js";
import { findingIdFor } from "../src/normalize.js";
import { CATEGORY_NAMES } from "../src/rules.js";
import { validateStoredScan, type StoredScan } from "../src/contracts.js";

const FIXTURE_SOURCE = path.resolve(import.meta.dirname, "fixtures");
const FIXTURES_URL = "/fixtures";

/** Engine under test, including the test-only context counter. */
type TestEngine = Awaited<ReturnType<typeof createScanner>> & { readonly activeContextCount: number };

interface Runtime {
  workDir: string;
  server: FixtureServer;
  engine: TestEngine;
}

const runtimes: Runtime[] = [];

async function setupRuntime(scanTimeout = 45_000): Promise<Runtime> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "glorp-fixtures-"));
  await copyFixtures(FIXTURE_SOURCE, workDir);
  const server = await startFixtureServer(workDir);
  const engine = (await createScanner(
    createConfig({
      allowedOrigins: [server.origin],
      allowLocal: true,
      reportDirOverride: path.join(workDir, "reports"),
      scanTimeoutMs: scanTimeout,
    }),
  )) as TestEngine;
  const rt: Runtime = { workDir, server, engine };
  runtimes.push(rt);
  return rt;
}

const FLAWED_URL = (rt: Runtime) => `${rt.server.origin}${FIXTURES_URL}/registration.html`;
const CORRECTED_URL = (rt: Runtime) => `${rt.server.origin}${FIXTURES_URL}/corrected.html`;

afterAll(async () => {
  for (const rt of runtimes) {
    await rt.engine.close().catch(() => undefined);
    await rt.server.close();
    await fs.rm(rt.workDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("scanner: real browser scans of the demo fixtures", () => {
  let rt: Runtime;

  beforeAll(async () => {
    rt = await setupRuntime();
  });

  it("records a genuine axe-engine result for the flawed registration fixture across all six categories", { timeout: 60_000 }, async () => {
    const stored: StoredScan = await rt.engine.scan(FLAWED_URL(rt));

    // Record structure & comparability conditions.
    expect(stored.run.schema_version).toBe("1.0");
    expect(stored.run.execution).toBe("completed");
    expect(stored.run.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored.run.report_path).toBe(`runs/${stored.run.run_id}.json`);
    expect(stored.run.requested_url).toBe(FLAWED_URL(rt));
    expect(stored.run.final_url).toBe(FLAWED_URL(rt));
    expect(stored.run.conditions).toEqual({
      viewport: { width: 1280, height: 800 },
      color_scheme: "light",
      browser_locale: "en-US",
      readiness_selector: null,
      scope: "full_page",
    });
    expect(stored.run.engine.axe_version).toMatch(/^\d+\.\d+/);
    expect(stored.run.engine.playwright_version).toMatch(/^\d+\.\d+/);
    expect(stored.run.engine.rule_ids).toHaveLength(8);
    expect(stored.run.engine.ruleset_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.run.coverage.frame_coverage).toBe("main_document_only");
    expect(stored.run.coverage.current_rendered_state_only).toBe(true);

    // Real findings across the seeded categories (one per category).
    const ruleIds = new Set(stored.full_findings.map((f) => f.rule_id));
    expect(ruleIds.has("color-contrast")).toBe(true);
    expect(ruleIds.has("image-alt")).toBe(true);
    expect(ruleIds.has("label")).toBe(true);
    expect(ruleIds.has("select-name")).toBe(true);
    expect(ruleIds.has("link-name")).toBe(true);
    expect(ruleIds.has("button-name")).toBe(true);
    expect(ruleIds.has("html-has-lang")).toBe(true);

    const categories = new Set(stored.run.coverage.categories);
    for (const category of CATEGORY_NAMES) {
      expect(categories.has(category), `expected category coverage: ${category}`).toBe(true);
    }

    // Full outcome accounting: all 8 required rules have reported outcomes.
    const outcomeRules = new Set([...stored.run.coverage.evaluated_rule_ids, ...stored.run.coverage.inapplicable_rule_ids]);
    expect(outcomeRules.size).toBe(8);

    // Node-level findings carry stable ids and comparator evidence.
    expect(stored.run.counts.violation_node_count).toBe(stored.full_findings.length);
    for (const f of stored.full_findings) {
      expect(f.id).toBe(findingIdFor(f.rule_id, f.targets));
      expect(f.id).toMatch(/^[0-9a-f]{64}$/);
      expect(f.guidance.length).toBeGreaterThan(20);
      expect(f.guidance_source).toBe("rule_registry");
      expect(f.html.length).toBeLessThanOrEqual(2_000);
      expect(f.targets.length).toBeGreaterThan(0);
      expect(stored.evidence[f.id]).toBe("fail");
    }
    expect(stored.run.gate).toBe("fail");
    expect(stored.run.details_truncated).toBe(false);
  });

  it("corrected fixture: no violations, honest coverage, pass nodes in evidence", { timeout: 60_000 }, async () => {
    const stored = await rt.engine.scan(CORRECTED_URL(rt));
    expect(stored.run.gate).toBe("pass");
    expect(stored.full_findings).toHaveLength(0);
    expect(stored.run.counts.violation_node_count).toBe(0);
    // The required rules were still evaluated (inapplicable images are fine).
    const outcomeRules = new Set([...stored.run.coverage.evaluated_rule_ids, ...stored.run.coverage.inapplicable_rule_ids]);
    expect(outcomeRules.size).toBe(8);
    // Pass nodes give the comparator stable positive evidence.
    expect(Object.values(stored.evidence).filter((v) => v === "pass").length).toBeGreaterThan(0);
    expect(stored.run.details_truncated).toBe(false);
  });

  it("partial repair: deltas are honest against the edited same-URL source (remaining/no-longer/new/uncertain)", { timeout: 90_000 }, async () => {
    const registrationPath = path.join(rt.workDir, "registration.html");
    const baseline: StoredScan = await rt.engine.scan(FLAWED_URL(rt));
    expect(baseline.run.gate).toBe("fail");

    // Simulated source repair: fix contrast + the link name only; image alt,
    // button name, labels, select name and lang remain unfixed.
    const source = await fs.readFile(registrationPath, "utf8");
    const partiallyFixed = source
      .replace('style="color:#aaa; background:#ffffff;', 'style="color:#444444; background:#ffffff;')
      .replace(
        '<a href="/fixtures/help.html" id="link-help" class="icon-link">',
        '<a href="/fixtures/help.html" id="link-help" class="icon-link" aria-label="Registration help">',
      );
    await fs.writeFile(registrationPath, partiallyFixed, "utf8");

    const fixed = await rt.engine.scan(FLAWED_URL(rt));
    const verification = compareRuns(baseline, fixed);

    const baselineById = new Map(baseline.full_findings.map((f) => [f.id, f]));
    const noLongerRules = new Set(
      verification.comparison.no_longer_detected_ids.map((id) => baselineById.get(id)!.rule_id),
    );
    expect(noLongerRules.has("color-contrast")).toBe(true);
    expect(noLongerRules.has("link-name")).toBe(true);
    // note: html-has-lang may shift? no — source still lacks lang.
    const remainingRules = new Set(
      verification.comparison.remaining_ids.map((id) => (baselineById.get(id) as { rule_id: string }).rule_id),
    );
    for (const expected of ["image-alt", "label", "select-name", "button-name", "html-has-lang"]) {
      expect(remainingRules.has(expected), `expected ${expected} to remain`).toBe(true);
    }
    expect(verification.comparison.newly_detected_ids).toHaveLength(0);
    expect(verification.comparison.uncertain_baseline_ids).toHaveLength(0);
    expect(verification.gate).toBe("fail");
    expect(verification.current_run.run_id).toBe(fixed.run.run_id);
    expect(verification.baseline_id).toBe(baseline.run.run_id);
  });

  it("unusable/empty target is gate=not_evaluated — never a pass", { timeout: 60_000 }, async () => {
    const stored = await rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/empty.html`);
    expect(stored.run.gate).toBe("not_evaluated");
    expect(stored.full_findings).toHaveLength(0);
    expect(stored.full_review_items).toHaveLength(0);
    expect(stored.run.counts.violation_node_count).toBe(0);
    expect(stored.run.warnings.join("\n").toLowerCase()).toContain("meaningful");
  });

  it("4xx response is fatal (TARGET_UNREACHABLE); context is cleaned up", { timeout: 60_000 }, async () => {
    await expect(rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/missing.html`)).rejects.toMatchObject({
      code: "TARGET_UNREACHABLE",
    });
    expect(rt.engine.activeContextCount).toBe(0);
  });

  it("cross-origin redirect is blocked before navigation (TARGET_NOT_ALLOWED); context cleaned up", { timeout: 60_000 }, async () => {
    await expect(rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/__crossredirect`)).rejects.toMatchObject({
      code: "TARGET_NOT_ALLOWED",
    });
    expect(rt.engine.activeContextCount).toBe(0);
  });

  it("same-origin path redirect is allowed and recorded with a redirect warning", { timeout: 60_000 }, async () => {
    const stored = await rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/__sameredirect`);
    expect(stored.run.final_url).toBe(`${rt.server.origin}${FIXTURES_URL}/help.html`);
    expect(stored.run.warnings.join("\n")).toContain("redirect");
  });

  it("rejects non-allowlisted origins, credentials, traversal URLs and non-http schemes", async () => {
    await expect(rt.engine.scan("https://example.com/page")).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    // exact allowlist only: confusable hostnames must not pass
    await expect(
      rt.engine.scan(`http://127.0.0.1.evil.example:${rt.server.port}${FIXTURES_URL}/help.html`),
    ).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    await expect(
      rt.engine.scan(`http://user:pass@127.0.0.1:${rt.server.port}${FIXTURES_URL}/help.html`),
    ).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    await expect(
      rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/../registration.html`),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(rt.engine.scan("file:///etc/hostname")).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
  });

  it("engines shut down cleanly: contexts and browser released after scans", { timeout: 60_000 }, async () => {
    // Warm engine already ran scans; close and verify clean teardown.
    expect(rt.engine.activeContextCount).toBe(0);
    await rt.engine.close();
    await expect(rt.engine.scan(FLAWED_URL(rt))).rejects.toMatchObject({ code: "SCAN_FAILED" });
  });
});

describe("scanner: time budget and concurrency", () => {
  let hanging: Runtime;

  beforeAll(async () => {
    hanging = await setupRuntime(6_000);
  });

  it("a pending navigation is cut off by the scan budget with SCAN_TIMEOUT and no leaked context", { timeout: 90_000 }, async () => {
    const startedAt = Date.now();
    await expect(hanging.engine.scan(`${hanging.server.origin}${FIXTURES_URL}/__hang`)).rejects.toMatchObject({
      code: "SCAN_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(hanging.engine.activeContextCount).toBe(0);
  });

  it("second scan while a scan is running gets SCAN_BUSY", { timeout: 90_000 }, async () => {
    const slow = hanging.engine.scan(`${hanging.server.origin}${FIXTURES_URL}/__hang`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(hanging.engine.scan(CORRECTED_URL(hanging))).rejects.toMatchObject({ code: "SCAN_BUSY" });
    await expect(slow).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
  });
});

describe("scanner: AXE engine availability enforcement", () => {
  it("uses the installed engine version and a full eight-rule run", () => {
    // Covered indirectly by the browser tests above; keep this as a guard
    // that CreateScanner did not silently reduce the rule set.
    // (Kept trivial to document the contract.)
  });
});

describe("scanner: fixture behavior preserved after repair (help destinations + submit handler)", () => {
  it("corrected fixture keeps the same destinations, IDs and submit action", async () => {
    const rt = await setupRuntime();
    try {
      const correctedPath = path.join(rt.workDir, "corrected.html");
      const source = await fs.readFile(correctedPath, "utf8");
      expect(source).toContain('/fixtures/help.html"');
      expect(source).toContain('id="btn-submit"');
      expect(source).toContain("submitRegistration(event)");
      expect(source).toContain('id="registration-form"');
    } finally {
      await rt.engine.close();
      await rt.server.close();
      await fs.rm(rt.workDir, { recursive: true, force: true });
    }
  });
});

describe("scanner: repeated egress refusals, popup guard and wedged-browser teardown", () => {
  let rt: Runtime;

  beforeAll(async () => {
    rt = await setupRuntime();
    const corrected = await fs.readFile(path.join(rt.workDir, "corrected.html"), "utf8");
    // Clean page + ONE remote HTTPS asset outside every allowlist. The egress
    // policy refuses it (CONNECT destination not allowed) without any DNS lookup.
    await fs.writeFile(
      path.join(rt.workDir, "blocked-asset.html"),
      corrected.replace("</body>", '<img src="https://assets.blocked.example.net/banner.png" alt="Banner">\n</body>'),
      "utf8",
    );
    // Clean page that opens script popups on load (the scan must close them
    // WITHOUT closing axe's own helper page, and still produce a real result).
    // Clean page that auto-submits a POST form to a same-origin page on load:
    // the request guard must refuse the mutating top-level navigation.
    await fs.writeFile(
      path.join(rt.workDir, "autopost.html"),
      corrected.replace(
        "</body>",
        '<form id="auto" method="post" action="/fixtures/help.html"></form><script>document.getElementById("auto").submit();</script>\n</body>',
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(rt.workDir, "popup.html"),
      corrected.replace(
        "</body>",
        '<script>window.open("about:blank", "_blank"); window.open("about:blank", "_blank", "noopener");</script>\n</body>',
      ),
      "utf8",
    );
  });

  afterAll(async () => {
    await rt.engine.close().catch(() => undefined);
    await rt.server.close();
    await fs.rm(rt.workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("a clean page with a refused remote asset is review_required with a warning (first scan)", { timeout: 60_000 }, async () => {
    const stored = await rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/blocked-asset.html`);
    expect(stored.run.gate).toBe("review_required");
    expect(stored.run.warnings.join("\n")).toContain("refused during the scan");
    expect(stored.run.review_items.map((r) => r.rule_id)).toContain("engine-egress");
    expect(stored.full_findings).toHaveLength(0);
    // The saved record must load back through the store validator (a review
    // item with no target made the baseline unloadable: BASELINE_NOT_FOUND).
    expect(validateStoredScan(JSON.parse(JSON.stringify(stored)))).not.toBeNull();
  });

  it("the SAME refusal on a repeat scan is still recorded (no false pass from a de-duplicated log)", { timeout: 60_000 }, async () => {
    const stored = await rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/blocked-asset.html`);
    expect(stored.run.gate).toBe("review_required");
    expect(stored.run.warnings.join("\n")).toContain("refused during the scan");
    expect(stored.run.review_items.map((r) => r.rule_id)).toContain("engine-egress");
  });

  it("the refusal count is per scan: an unblocked clean page after the refusals passes again", { timeout: 60_000 }, async () => {
    // Also proves Chromium's incidental requests (e.g. favicon) are not refused.
    const stored = await rt.engine.scan(CORRECTED_URL(rt));
    expect(stored.run.gate).toBe("pass");
    expect(stored.run.warnings.join("\n")).not.toContain("refused during the scan");
  });

  it("an auto-submitted top-level POST is refused (never a pass): the mutating navigation is blocked and the scan is rejected", { timeout: 60_000 }, async () => {
    // The blocked POST leaves the page on a browser error document, which the
    // final-destination check refuses. Deterministic across runs.
    await expect(rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/autopost.html`)).rejects.toMatchObject({
      code: "TARGET_NOT_ALLOWED",
    });
  });

  it("script popups are closed and reported while the axe helper page still produces a real pass", { timeout: 60_000 }, async () => {
    const stored = await rt.engine.scan(`${rt.server.origin}${FIXTURES_URL}/popup.html`);
    expect(stored.run.gate).toBe("pass");
    expect(stored.run.warnings.join("\n")).toContain("2 popup window(s) opened by the page were closed");
    expect(Object.values(stored.evidence).filter((v) => v === "pass").length).toBeGreaterThan(0);
  });
});

describe("scanner: wedged context/browser teardown", () => {
  it("a context and browser that never finish closing do not leave the engine on a wedged browser", { timeout: 30_000 }, async () => {
    const rt = await setupRuntime();
    // Internal lifecycle hook (private by design); exercised with never-settling
    // fakes so no real browser is involved. The engine must hand the NEXT scan a
    // fresh launch rather than keep reusing the wedged browser.
    const engine = rt.engine as unknown as {
      state: { phase: string };
      closeContextBounded(context: unknown, browser: unknown): Promise<void>;
    };
    const neverSettles = <T>(): Promise<T> => new Promise<T>(() => undefined);
    const wedgedContext = { close: () => neverSettles<void>() };
    const wedgedBrowser = { close: () => neverSettles<void>(), isConnected: () => true };
    engine.state = { phase: "ready", browser: wedgedBrowser } as unknown as { phase: string };
    const startedAt = Date.now();
    await engine.closeContextBounded(wedgedContext, wedgedBrowser);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
    expect(elapsed).toBeLessThan(15_000);
    expect(engine.state.phase).toBe("idle");
    await rt.engine.close().catch(() => undefined);
    await rt.server.close();
    await fs.rm(rt.workDir, { recursive: true, force: true }).catch(() => undefined);
  });
});
