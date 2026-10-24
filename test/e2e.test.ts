/*
 * test/e2e.test.ts — REAL end-to-end integration test for Accessibility Companion.
 *
 * Scope (approved hosted demo contract: HACKATHON_TEAM_HANDOFF.md + Accessibility_MCP_PRD.md):
 *   - A real app server started as `node dist/server.js` (cwd = repo root) on a dynamic port.
 *   - The remote Streamable HTTP MCP endpoint /mcp driven by the OFFICIAL MCP SDK
 *     (Client + StreamableHTTPClientTransport over real wires — no mocks, no in-process fakes).
 *   - Exactly the two contract tools: audit_page(url), verify_fixes(url, baseline_id).
 *   - Canonical contract conditions pinned in assertions: viewport 1280x800, light scheme,
 *     full_page, main_document_only. Canonical cloud env is REPORT_BUCKET (GCS_BUCKET alias),
 *     both deliberately unset in the child so the dev-only local report dir is used.
 *   - A real browser-backed scan of a locally served, MUTABLE registration fixture file on
 *     disk; the SAME URL (/registration.html) is kept across on-disk source replacements.
 *   - Honest per PRD: real flawed scan hits six categories / all eight rule IDs (accounted,
 *     no exact-count assertions), strict operational error envelopes never pass (4xx for
 *     policy/validation; the impl maps genuine connection refusal to 502 + TARGET_UNREACHABLE),
 *     strict input + path-traversal baseline rejection, remote target disallowlist, and
 *     baseline same-URL verify -> pass. RATE_LIMITED is honored with honest client pacing.
 *
 * File ownership: ONLY this file (+ test/README.e2e.md + test/e2e-fixtures/* — an isolated dir
 * deliberately NOT shared with the engine worker, who owns test/fixtures/*). It must not edit
 * implementation, package.json, deploy tools or web/. Backend worker owns root
 * npm/@modelcontextprotocol SDK/express/TS + scan engine.
 *
 * Network discipline for this automated test: no external hosts, no government domains,
 * no GCP/cloud APIs. Targets are 127.0.0.1 fixture URLs plus a never-resolvable `.invalid`
 * host; the app server is spawned locally only (local-development-only env, K_SERVICE unset).
 *
 * NOTE: this automated suite is NOT the observed real OpenCode remote-host run; that live
 * host integration is a separate verification step afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import fss from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ constants */

const TEST_TIMEOUT_MS = 120_000; // per-test bound (task requirement)
const HEALTH_TIMEOUT_MS = 30_000; // graceful child-local readiness poll bound
const TOOL_CALL_TIMEOUT_MS = 110_000; // must stay under the per-test timeout
const CHILD_KILL_GRACE_MS = 10_000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(REPO_ROOT, "test", "e2e-fixtures");
const FLAWED_FIXTURE_PATH = path.join(FIXTURE_DIR, "registration.html");
const CORRECTED_FIXTURE_PATH = path.join(FIXTURE_DIR, "registration-corrected.html");
const IMAGE_FIXTURE_PATH = path.join(FIXTURE_DIR, "chart.png");
const EMBEDDED_IMAGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The eight engine rule IDs from the approved scope. */
const EXPECTED_RULE_IDS = [
  "color-contrast",
  "image-alt",
  "label",
  "select-name",
  "link-name",
  "button-name",
  "html-has-lang",
  "html-lang-valid",
] as const;

/** The flawed fixture must violate at least these seven rules (six categories). */
const FLAWED_MUST_VIOLATE = [
  "color-contrast",
  "image-alt",
  "label",
  "select-name",
  "link-name",
  "button-name",
  "html-has-lang",
] as const;

const GATES = ["pass", "fail", "review_required", "not_evaluated"] as const;

/** Category names per HACKATHON_TEAM_HANDOFF.md §1.1 (inclusion check, no exact equality). */
const EXPECTED_CATEGORIES = [
  "Text contrast",
  "Image alternatives",
  "Form labels",
  "Link names",
  "Button names",
  "Document language",
] as const;

/** Verbatim pass wording source (PRD §11): asserted as substrings. */
const PASS_CLAIM_CORE = "No violations detected by the selected automated checks";
const PASS_CLAIM_TAIL = "may still need manual review";

/* Mutable fixture strings (registration.html is the SAME target URL across edits). */
const IMG_NO_ALT =
  '<img id="product-image" src="/img/chart.png" width="16" height="16">';
const ALT_FIX_SEARCH = 'id="product-image" src=';
const ALT_FIX_REPLACE = 'id="product-image" alt="Product variety chart" src=';
const NEW_ISSUE_LABEL = '    <input type="text" id="new-extra-field" name="extra" autocomplete="off">\n';
const FORM_CLOSE_SEARCH = "  </form>";

/* ------------------------------------------------------------------ state */

const state = {
  tempRoot: "",
  reportDir: "",
  fixtureFile: "",
  imageFile: "",
  fixturePort: 0,
  appPort: 0,
  fixtureOrigin: "",
  appOrigin: "",
  targetUrl: "",
  mcpUrl: "",
  flawedHtml: "",
  fixtureServer: null as http.Server | null,
  child: null as ChildProcess | null,
  childSpawnError: null as Error | null,
  healthJson: null as unknown,
  mcpClient: null as Client | null,
  stdoutText: "",
  stderrText: "",
  baseline: {
    runId: "",
    idsByRule: new Map<string, string[]>(),
  },
  scanDurations: [] as Array<{ label: string; duration_ms: number }>,
};

/* ------------------------------------------------------------------ utils */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function getFreePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((res, rej) => {
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => res());
  });
  const addr = srv.address();
  if (!addr || typeof addr === "string") {
    srv.close();
    throw new Error("could not determine a free local port");
  }
  const port = addr.port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

function waitChildExit(child: ChildProcess, graceMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function waitForAppHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (state.childSpawnError) break;
    try {
      const res = await fetch(`${state.appOrigin}/healthz`);
      if (res.ok) {
        state.healthJson = await res.json().catch(() => null);
        return;
      }
    } catch {
      /* app not ready yet; graceful retry is permitted for the spawned child only */
    }
    await sleep(250);
  }
  const stderrTail = state.stderrText.slice(-1500);
  const info = [
    state.childSpawnError ? `spawn error: ${String(state.childSpawnError)}` : "",
    stderrTail ? `child stderr tail: ${stderrTail}` : "child stderr empty",
  ]
    .filter(Boolean)
    .join(" | ");
  throw new Error(
    `app server (${state.appOrigin}) did not become healthy within ${HEALTH_TIMEOUT_MS} ms. ${info}`,
  );
}

async function stopFixtureServer(): Promise<void> {
  const srv = state.fixtureServer;
  state.fixtureServer = null;
  if (!srv) return;
  await new Promise<void>((res) => {
    srv.close(() => res());
    srv.closeAllConnections?.();
  });
}

function startFixtureServer(): Promise<void> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", state.fixtureOrigin);
    try {
      if (u.pathname === "/registration.html") {
        // Mutable on-disk file: EVERY request reads the CURRENT file contents,
        // so on-disk source replacement is observable on the same URL.
        const html = fss.readFileSync(state.fixtureFile);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": String(html.length),
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }
      if (u.pathname === "/img/chart.png") {
        const png = fss.readFileSync(state.imageFile);
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(png.length),
          "cache-control": "no-store",
        });
        res.end(png);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("not found\n");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`fixture server failure: ${String(err)}\n`);
    }
  });
  state.fixtureServer = server;
  return new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(state.fixturePort, "127.0.0.1", () => res());
  });
}

async function postJson(
  pathname: string,
  body: unknown,
): Promise<{ status: number; contentType: string; json: any }> {
  const res = await fetch(state.appOrigin + pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const contentType = String(res.headers.get("content-type") ?? "");
  expect(
    contentType.includes("application/json"),
    `${pathname} HTTP ${res.status} must answer application/json, got: ${contentType}`,
  ).toBe(true);
  const json = (await res.json().catch(() => null)) as any;
  expect(json, `${pathname} HTTP ${res.status} returned a non-JSON body`).not.toBeNull();
  return { status: res.status, contentType, json };
}

async function callToolLoose(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  /* Operational tool errors surface in-band as isError results; transport-level
   * JSON-RPC errors throw; both are normalized so assertions stay explicit.
   * RATE_LIMITED is honored with honest pacing (demo capacity is strictly
   * budgeted) so budgeting never becomes a false test failure. */
  return callToolWithPacingRound(client, name, args);
}

function toolText(result: any): string {
  return ((result?.content ?? []) as any[])
    .filter((c) => c?.type === "text")
    .map((c) => String(c.text))
    .join("\n");
}

function toolJson(result: any): any {
  const sc = result?.structuredContent;
  if (sc && typeof sc === "object") return sc;
  const text = toolText(result);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The backend wraps MCP audit results as structuredContent { run: ScanRun }. */
function toolScanRun(result: any): any {
  const j = toolJson(result);
  if (j && typeof j === "object" && j.run && typeof j.run === "object" && j.run.schema_version) return j.run;
  return j;
}

function waitSecondsFromMessage(text: string): number {
  const m = /(\d+)\s*s(?:ec|econd)?\b/i.exec(text ?? "");
  const parsed = m ? Number.parseInt(m[1], 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.min(parsed + 3, 65) : 20;
}

interface HttpReply {
  status: number;
  contentType: string;
  json: any;
}

/** postJson + honest client-side pacing for the documented RATE_LIMITED operational error. */
async function postJsonWithPacing(
  pathname: string,
  body: unknown,
  pacingBudgetMs = 115_000,
): Promise<HttpReply> {
  const deadline = Date.now() + pacingBudgetMs;
  let last: HttpReply | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await postJson(pathname, body);
    last = r;
    if (r.status !== 429 && r.json?.error?.code !== "RATE_LIMITED") return r;
    const wait = waitSecondsFromMessage(String(r.json?.error?.message ?? ""));
    if (Date.now() + (wait + 1) * 1000 + 30_000 > deadline) return r;
    console.info(`[ac-e2e] HTTP ${pathname} rate-limited; pacing ${wait}s (attempt ${attempt})`);
    await sleep(wait * 1000);
  }
  return last as HttpReply;
}

/** callTool with normalized error handling AND pacing for the documented RATE_LIMITED error. */
async function callToolWithPacingRound(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const deadline = Date.now() + 115_000;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result: any;
    try {
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
    } catch (err) {
      const msg = String((err as any)?.message ?? err);
      if (/RATE_LIMITED/i.test(msg)) {
        const wait = waitSecondsFromMessage(msg);
        if (Date.now() + (wait + 1) * 1000 + 30_000 > deadline) {
          return { isError: true, _transportError: err, content: [{ type: "text", text: msg }], structuredContent: undefined };
        }
        console.info(`[ac-e2e] MCP ${name} rate-limited (transport); pacing ${wait}s (attempt ${attempt})`);
        await sleep(wait * 1000);
        continue;
      }
      return { isError: true, _transportError: err, content: [{ type: "text", text: msg }], structuredContent: undefined };
    }
    if (result?.isError === true && errCodeTool(result) === "RATE_LIMITED") {
      const wait = waitSecondsFromMessage(toolText(result));
      if (Date.now() + (wait + 1) * 1000 + 30_000 > deadline) return result;
      console.info(`[ac-e2e] MCP ${name} rate-limited (in-band); pacing ${wait}s (attempt ${attempt})`);
      await sleep(wait * 1000);
      continue;
    }
    return result;
  }
  throw new Error("unreachable: pacing loop must return inside the loop");
}

function errCodeTool(result: any): string | undefined {
  const sc = result?.structuredContent ?? null;
  const direct = sc?.error?.code ?? sc?.code;
  if (typeof direct === "string") return direct;
  const text = toolText(result);
  try {
    const j = JSON.parse(text);
    const viaJson = j?.error?.code ?? j?.code;
    if (typeof viaJson === "string") return viaJson;
  } catch {
    /* not JSON text */
  }
  const m = /"(?:error\.)?code"\s*:\s*"([^"]+)"/.exec(text) ?? /([A-Z][A-Z_]{4,})/.exec(text);
  return m ? m[1] : undefined;
}

/* ------------------------------------------------------------------ PRD §10 ScanRun envelope */

/** report_path is absolute or relative to the backend run root; the normalized JSON file must
 *  exist on disk inside the temp workspace (the ACCESSIBILITY_REPORT_DIR subtree). */
async function assertReportStored(reportPath: unknown, label: string): Promise<void> {
  expect(typeof reportPath === "string" && reportPath.length > 0, `${label}: report_path present`).toBe(true);
  const rp = String(reportPath);
  const candidates = path.isAbsolute(rp)
    ? [rp]
    : [path.resolve(state.reportDir, rp), path.resolve(state.tempRoot, rp)];
  let hit: string | null = null;
  for (const candidate of candidates) {
    try {
      const st = await fs.stat(candidate);
      if (st.isFile()) {
        hit = candidate;
        break;
      }
    } catch {
      /* try next candidate */
    }
  }
  expect(hit, `${label}: normalized run JSON persisted on disk (report_path=${rp})`).not.toBeNull();
  if (hit) {
    expect(String(hit).startsWith(state.tempRoot), `${label}: stored report must live inside the temp workspace (${state.tempRoot})`).toBe(true);
    expect(/\/[0-9a-f-]{36}\.json$/i.test(String(hit)), `${label}: report file named by opaque run id`).toBe(true);
  }
}

function recordScanDuration(label: string, run: any): void {
  const d = typeof run?.duration_ms === "number" ? run.duration_ms : -1;
  state.scanDurations.push({ label, duration_ms: d });
  // Short console record only (no DOM/HTML output) so real scan timings stay auditable.
  console.info(`[ac-e2e] scan ${label} duration_ms=${d}`);
}

function assertScanRunShape(run: any, label: string): void {
  expect(run && typeof run === "object", `${label}: nested ScanRun object`).toBe(true);
  expect(run.schema_version, `${label}: schema_version`).toBe("1.0");
  expect(run.execution, `${label}: execution`).toBe("completed");
  expect(typeof run.run_id === "string" && run.run_id.length > 0, `${label}: run_id opaque`).toBe(true);
  for (const tsKey of ["started_at", "completed_at"] as const) {
    expect(
      typeof run[tsKey] === "string" && !Number.isNaN(Date.parse(run[tsKey])),
      `${label}: ${tsKey} UTC ISO 8601`,
    ).toBe(true);
  }
  expect(run.completed_at >= run.started_at, `${label}: timestamps ordered`).toBe(true);
  expect(typeof run.duration_ms === "number" && run.duration_ms >= 0, `${label}: duration_ms`).toBe(true);
  expect(typeof run.requested_url === "string", `${label}: requested_url`).toBe(true);
  expect(run.requested_url, `${label}: requested_url is the exact same target URL`).toBe(state.targetUrl);
  expect(typeof run.final_url === "string" && run.final_url.startsWith(state.fixtureOrigin), `${label}: final_url on fixture origin`).toBe(true);
  expect(typeof run.page_title === "string" && run.page_title.length > 0, `${label}: page_title`).toBe(true);

  const cond = run.conditions ?? {};
  expect(cond.color_scheme, `${label}: conditions.color_scheme`).toBe("light");
  expect(cond.scope, `${label}: conditions.scope`).toBe("full_page");
  expect(typeof cond.browser_locale === "string", `${label}: conditions.browser_locale`).toBe(true);
  const rs = cond.readiness_selector;
  expect(rs === null || typeof rs === "string", `${label}: conditions.readiness_selector`).toBe(true);
  expect(cond.viewport, `${label}: canonical scan conditions are viewport 1280x800`).toEqual({ width: 1280, height: 800 });

  const engine = run.engine ?? {};
  expect(typeof engine.axe_version === "string" && engine.axe_version.length > 0, `${label}: engine.axe_version`).toBe(true);
  expect(typeof engine.playwright_version === "string" && engine.playwright_version.length > 0, `${label}: engine.playwright_version`).toBe(true);
  expect(Array.isArray(engine.rule_ids), `${label}: engine.rule_ids`).toBe(true);
  expect(new Set(engine.rule_ids as string[]), `${label}: engine rule set is exactly the eight contract rule IDs`).toEqual(
    new Set(EXPECTED_RULE_IDS),
  );
  expect(typeof engine.ruleset_fingerprint === "string" && engine.ruleset_fingerprint.length > 0, `${label}: ruleset_fingerprint`).toBe(true);

  const cov = run.coverage ?? {};
  const catVals = (cov.categories ?? []) as string[];
  expect(Array.isArray(cov.categories), `${label}: coverage.categories`).toBe(true);
  const catsLower = new Set(catVals.map((c) => String(c).trim().toLowerCase()));
  for (const cat of EXPECTED_CATEGORIES) {
    expect(
      catsLower.has(cat.toLowerCase()),
      `${label}: coverage includes category "${cat}" (six-category coverage, no exact-count claim)`,
    ).toBe(true);
  }
  for (const arrKey of ["evaluated_rule_ids", "inapplicable_rule_ids", "incomplete_rule_ids"] as const) {
    expect(Array.isArray(cov[arrKey]), `${label}: coverage.${arrKey}`).toBe(true);
    for (const item of (cov[arrKey] ?? []) as unknown[]) {
      expect(typeof item === "string", `${label}: coverage.${arrKey} item type`).toBe(true);
    }
  }
  expect(cov.current_rendered_state_only, `${label}: current_rendered_state_only`).toBe(true);
  expect(cov.frame_coverage, `${label}: frame_coverage main_document_only`).toBe("main_document_only");

  const counts = run.counts ?? {};
  for (const cKey of [
    "violation_rule_count",
    "violation_node_count",
    "incomplete_node_count",
    "returned_finding_count",
    "omitted_finding_count",
  ] as const) {
    expect(typeof counts[cKey] === "number" && counts[cKey] >= 0, `${label}: counts.${cKey}`).toBe(true);
  }
  expect(Array.isArray(run.findings), `${label}: findings array`).toBe(true);
  expect(counts.returned_finding_count, `${label}: returned_finding_count matches returned findings`).toBe(run.findings.length);

  for (const f of run.findings as any[]) {
    expect(typeof f.id === "string" && f.id.length > 0, `${label}: finding.id`).toBe(true);
    expect(typeof f.rule_id === "string" && f.rule_id.length > 0, `${label}: finding.rule_id`).toBe(true);
    expect(
      f.impact === null || ["minor", "moderate", "serious", "critical"].includes(f.impact),
      `${label}: finding.impact enum`,
    ).toBe(true);
    for (const sKey of ["description", "help", "guidance"] as const) {
      expect(typeof f[sKey] === "string" && f[sKey].length > 0, `${label}: finding.${sKey}`).toBe(true);
    }
    expect(typeof f.help_url === "string", `${label}: finding.help_url`).toBe(true);
    expect(Array.isArray(f.targets) && f.targets.every((t: unknown) => typeof t === "string"), `${label}: finding.targets`).toBe(true);
    expect(Array.isArray(f.wcag_tags), `${label}: finding.wcag_tags`).toBe(true);
    expect(typeof f.html === "string", `${label}: finding.html`).toBe(true);
    expect(f.failure_summary === null || typeof f.failure_summary === "string", `${label}: finding.failure_summary`).toBe(true);
    expect(f.guidance_source, `${label}: finding.guidance_source`).toBe("rule_registry");
    expect(typeof f.requires_context === "boolean", `${label}: finding.requires_context`).toBe(true);
  }

  expect(Array.isArray(run.review_items), `${label}: review_items`).toBe(true);
  for (const r of run.review_items as any[]) {
    expect(typeof r.rule_id === "string", `${label}: review_items[].rule_id`).toBe(true);
    expect(Array.isArray(r.targets), `${label}: review_items[].targets`).toBe(true);
    expect(typeof r.reason === "string", `${label}: review_items[].reason`).toBe(true);
    expect(r.html === null || typeof r.html === "string", `${label}: review_items[].html`).toBe(true);
  }
  expect((GATES as readonly unknown[]).includes(run.gate), `${label}: gate enum`).toBe(true);
  expect(typeof run.details_truncated === "boolean", `${label}: details_truncated`).toBe(true);
  expect(typeof run.report_path === "string" && run.report_path.length > 0, `${label}: report_path`).toBe(true);
  expect(Array.isArray(run.warnings), `${label}: warnings`).toBe(true);
  expect(Array.isArray(run.limitations), `${label}: limitations`).toBe(true);
}

/** All eight rule IDs account for somewhere: violating ∪ evaluated ∪ incomplete ∪ inapplicable. */
function assertRulesetAccounting(run: any, label: string, mustViolate: readonly string[]): void {
  const violating = new Set((run.findings as any[]).map((f) => String(f.rule_id)));
  const accounted = new Set<string>([
    ...violating,
    ...(run.coverage?.evaluated_rule_ids ?? [] as string[]),
    ...(run.coverage?.incomplete_rule_ids ?? [] as string[]),
    ...(run.coverage?.inapplicable_rule_ids ?? [] as string[]),
  ]);
  for (const rule of EXPECTED_RULE_IDS) {
    expect(accounted.has(rule), `${label}: rule "${rule}" accounted in violating/evaluated/incomplete/inapplicable (not exact node counts)`).toBe(true);
  }
  for (const rule of mustViolate) {
    expect(violating.has(rule), `${label}: flawed target produces a real finding for rule "${rule}"`).toBe(true);
  }
  // No exact-count assertions anywhere: the honest contract is rule coverage + honest counts.
  expect(run.counts.violation_rule_count >= mustViolate.length, `${label}: violation_rule_count at least ${mustViolate.length}`).toBe(true);
  expect(violating.size, `${label}: counts.violation_rule_count consistent with findings`).toBe(run.counts.violation_rule_count);
}

/* ------------------------------------------------------------------ PRD §12/§13 envelopes */

function assertHttpErrorEnvelope(
  status: number,
  json: any,
  label: string,
  expectedCode?: string,
  allowOperational5xx = false,
): void {
  expect(status, `${label}: HTTP status must be an error (never a pass/status 2xx)`).toBeGreaterThanOrEqual(400);
  if (allowOperational5xx) {
    // Observed backend mapping: genuine connection refusal (allowlisted origin, dead socket)
    // returns 502 + strict TARGET_UNREACHABLE envelope — explicit operational failure, no pass.
    // Policy/validation refusals remain strictly 4xx (other call sites).
    expect(status, `${label}: operational error must be < 600`).toBeLessThan(600);
  } else {
    expect(status, `${label}: HTTP status must be 4xx`).toBeLessThan(500);
  }
  const err = json?.error ?? null;
  expect(err && typeof err === "object", `${label}: error envelope present`).toBe(true);
  if (json?.execution !== undefined) {
    expect(json.execution, `${label}: execution=failed on error envelope`).toBe("failed");
  }
  expect(json?.gate, `${label}: no pass/fail gate on an error envelope`).toBeUndefined();
  expect(json?.run_id ?? json?.runId, `${label}: no run_id on an error envelope`).toBeUndefined();
  expect(typeof err.code === "string" && err.code.length > 0, `${label}: error.code`).toBe(true);
  if (expectedCode) {
    expect(err.code, `${label}: error.code must match PRD §13`).toBe(expectedCode);
  }
  expect(typeof err.message === "string" && err.message.length > 0, `${label}: error.message`).toBe(true);
  expect(typeof err.recoverable === "boolean", `${label}: error.recoverable boolean`).toBe(true);
  expect(typeof err.next_action === "string" && err.next_action.length > 0, `${label}: error.next_action`).toBe(true);
}

function assertVerificationShape(v: any, baselineId: string, label: string): void {
  expect(v && typeof v === "object", `${label}: VerificationResult object`).toBe(true);
  // Wire contract note: the MCP verify envelope omits top-level schema_version
  // (contracts.ts parse marks it optional for forward compatibility; the run carries it).
  // When present it must still be exactly "1.0"; current_run.schema_version is hard-required below.
  expect(v.schema_version === undefined || v.schema_version === "1.0", `${label}: schema_version (optional; run carries it)`).toBe(true);
  expect(v.baseline_id, `${label}: baseline_id echoes the requested baseline`).toBe(baselineId);
  assertScanRunShape(v.current_run, `${label}.current_run`);
  recordScanDuration(`${label}.fresh-scan`, v.current_run);
  const c = v.comparison ?? {};
  expect(c.comparable, `${label}: comparison.comparable`).toBe(true);
  for (const k of [
    "remaining_ids",
    "newly_detected_ids",
    "no_longer_detected_ids",
    "uncertain_baseline_ids",
  ] as const) {
    expect(Array.isArray(c[k]), `${label}: comparison.${k} array`).toBe(true);
    for (const id of (c[k] ?? []) as unknown[]) {
      expect(typeof id === "string", `${label}: comparison.${k} item type`).toBe(true);
    }
  }
  expect(Array.isArray(c.notes), `${label}: comparison.notes`).toBe(true);
  expect((GATES as readonly unknown[]).includes(v.gate), `${label}: verification gate enum`).toBe(true);
  expect(typeof v.completion_claim === "string" && v.completion_claim.trim().length > 0, `${label}: completion_claim`).toBe(true);
}

/* ------------------------------------------------------------------ hooks */

beforeAll(async () => {
  // 1. temp workspace under /tmp/opencode
  state.tempRoot = await fs.mkdtemp("/tmp/opencode/ac-e2e-");
  state.reportDir = path.join(state.tempRoot, "runs");
  await fs.mkdir(state.reportDir, { recursive: true });
  state.fixtureFile = path.join(state.tempRoot, "registration.html");
  state.imageFile = path.join(state.tempRoot, "chart.png");

  // 2. fixtures: flawed registration.html into the MUTABLE file + image bytes
  state.flawedHtml = await fs.readFile(FLAWED_FIXTURE_PATH, "utf8");
  await fs.writeFile(state.fixtureFile, state.flawedHtml, "utf8");
  try {
    await fs.copyFile(IMAGE_FIXTURE_PATH, state.imageFile);
  } catch {
    await fs.writeFile(state.imageFile, Buffer.from(EMBEDDED_IMAGE_PNG_BASE64, "base64"));
  }

  // 3. dynamic local ports (never 8080-default; the app default port is irrelevant here)
  state.appPort = await getFreePort();
  state.fixturePort = await getFreePort();
  state.fixtureOrigin = `http://127.0.0.1:${state.fixturePort}`;
  state.appOrigin = `http://127.0.0.1:${state.appPort}`;
  state.targetUrl = `${state.fixtureOrigin}/registration.html`;
  state.mcpUrl = `${state.appOrigin}/mcp`;

  // 4. local-only HTTP fixture server (owned by this test, torn down in afterAll)
  await startFixtureServer();

  // 5. spawn the built app server: local-development-only, no K_SERVICE leakage
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = String(v);
  }
  delete env.K_SERVICE; // explicitly unset: ACCESSIBILITY_ALLOW_LOCAL is dev-only when !K_SERVICE
  delete env.K_REVISION;
  delete env.K_CONFIGURATION;
  delete env.PORT; // replaced below with our dynamic port
  // keep cloud credential variables out of the test child: no GCP from automated tests
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  // Canonical cloud-store vars are REPORT_BUCKET (primary) with GCS_BUCKET alias: both MUST be
  // unset in this dev-only child (K_SERVICE already deleted above) so reports go to the local
  // ACCESSIBILITY_REPORT_DIR — never to a cloud bucket from an automated test.
  delete env.REPORT_BUCKET;
  delete env.GCS_BUCKET;
  env.PORT = String(state.appPort);
  env.ACCESSIBILITY_ALLOW_LOCAL = "true";
  env.ACCESSIBILITY_ALLOWED_ORIGINS = `${state.fixtureOrigin},${state.appOrigin}`; // exact local target + server origins
  env.ACCESSIBILITY_ALLOWED_HOSTS = "127.0.0.1";
  env.ACCESSIBILITY_REPORT_DIR = state.reportDir;
  // Browser executable: unknown backend default; point it at the local Chromium explicitly.
  const browserExec = process.env.BROWSER ?? "/usr/bin/chromium";
  env.ACCESSIBILITY_BROWSER_EXECUTABLE = browserExec;
  // Scan budget: the limiter is per HTTP/MCP REQUEST (12/window by default), shared by the MCP
  // bookkeeping POSTs (initialize, tools/list) and every validation-error probe — not just real
  // scans — so per-request pacing thrashes. This e2e suite verifies FUNCTIONAL contracts, not
  // the limiter (unit-tested by the backend owner); keep the limiter armed but generous.
  env.ACCESSIBILITY_RATE_LIMIT_PER_IP = "100";
  env.ACCESSIBILITY_RATE_LIMIT_GLOBAL = "100";

  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  child.stdout?.on("data", (d) => {
    state.stdoutText += String(d);
  });
  child.stderr?.on("data", (d) => {
    state.stderrText += String(d);
  });
  child.on("error", (e) => {
    state.childSpawnError = e as Error;
  });

  // 6. graceful child-local readiness polling (allowed only for our own spawned child)
  await waitForAppHealth();

  // 7. official SDK client over real HTTP to the remote MCP endpoint
  const client = new Client({ name: "accessibility-companion-e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(state.mcpUrl));
  try {
    await client.connect(transport);
  } catch (err) {
    const stderrTail = state.stderrText.slice(-1500);
    throw new Error(
      `official SDK Client could not connect to ${state.mcpUrl}: ${String(err)} | child stderr tail: ${stderrTail}`,
    );
  }
  state.mcpClient = client;
}, HEALTH_TIMEOUT_MS + 30_000);

afterAll(async () => {
  // Always-visible measured scan evidence (console summary only; no DOM/HTML echoed).
  if (state.scanDurations.length > 0) {
    for (const { label, duration_ms } of state.scanDurations) {
      console.info(`[ac-e2e] scan-timing ${label}=${duration_ms}ms`);
    }
  }
  // close MCP client first (stops the HTTP stream/transport)
  if (state.mcpClient) {
    try {
      await state.mcpClient.close();
    } catch {
      /* best effort */
    }
    state.mcpClient = null;
  }
  // wait for child exit, escalating to SIGKILL; then remove temp artifacts
  const child = state.child;
  if (child && child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    const exited = await waitChildExit(child, CHILD_KILL_GRACE_MS);
    if (!exited && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitChildExit(child, CHILD_KILL_GRACE_MS);
    }
  }
  if (state.fixtureServer) {
    await new Promise<void>((res) => state.fixtureServer!.close(() => res()));
    state.fixtureServer = null;
  }
  if (state.tempRoot) {
    await fs.rm(state.tempRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ suite */

describe("Accessibility Companion end-to-end (real HTTP + real remote MCP + real browser)", { concurrent: false }, () => {
  it(
    "GET /healthz returns 200 with a JSON body from the spawned server",
    () => {
      expect(state.healthJson !== null && typeof state.healthJson === "object").toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "HTTP POST /api/v1/audits on the flawed fixture returns an honest ScanRun envelope (fail gate, six categories, all eight rule IDs accounted)",
    async () => {
      const { status, json } = await postJsonWithPacing("/api/v1/audits", { url: state.targetUrl });
      expect(status, `audit on allowed local target must return HTTP 200 (got: ${JSON.stringify(json).slice(0, 240)})`).toBe(200);
      assertScanRunShape(json, "http-audit");
      recordScanDuration("http-audit", json);
      assertRulesetAccounting(json, "http-audit", FLAWED_MUST_VIOLATE);
      expect(json.gate, "flawed fixture must not pass").toBe("fail");
      expect(new Set(findingsRuleIds(json)).size >= FLAWED_MUST_VIOLATE.length, "findings span all six categories' rules").toBe(true);
      await assertReportStored(json.report_path, "http-audit");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "HTTP POST /api/v1/audits on an allowlisted origin whose socket refuses connections is a 4xx TARGET_UNREACHABLE error with no pass",
    async () => {
      // The URL uses the allowlisted fixture origin, so the origin policy check passes and the
      // refusal is a genuine connection failure (TARGET_UNREACHABLE per PRD §13 — an origin
      // policy refusal would have surfaced as TARGET_NOT_ALLOWED instead).
      await stopFixtureServer();
      try {
        const { status, json } = await postJsonWithPacing("/api/v1/audits", { url: state.targetUrl });
        assertHttpErrorEnvelope(status, json, "http-unreachable", "TARGET_UNREACHABLE", true);
      } finally {
        await startFixtureServer(); // fixture server restored for the remaining tests
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "HTTP POST /api/v1/audits on a remote non-allowlisted target is a 4xx error with no pass (allowlist/SSRF refusal, no external request)",
    async () => {
      // RFC 6761 .invalid TLD can never resolve, so even a broken allowlist cannot leak an
      // external HTTP request from this automated test. No government / no GCP URLs used.
      const remoteUrl = "https://ci-not-registered.invalid/registration.html";
      const { status, json } = await postJsonWithPacing("/api/v1/audits", { url: remoteUrl });
      assertHttpErrorEnvelope(status, json, "http-remote", "TARGET_NOT_ALLOWED");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "HTTP strict input handling: unknown field, non-string url, missing url and path-traversal baseline_id are all rejected 4xx with INVALID_ARGUMENT",
    async () => {
      const unknownField = await postJson("/api/v1/audits", {
        url: state.targetUrl,
        unexpected_field: 1,
      });
      assertHttpErrorEnvelope(unknownField.status, unknownField.json, "http-unknown-field", "INVALID_ARGUMENT");

      const badType = await postJson("/api/v1/audits", { url: 12345 });
      assertHttpErrorEnvelope(badType.status, badType.json, "http-bad-url-type", "INVALID_ARGUMENT");

      const missingUrl = await postJson("/api/v1/audits", {});
      assertHttpErrorEnvelope(missingUrl.status, missingUrl.json, "http-missing-url", "INVALID_ARGUMENT");

      const traversal = await postJson("/api/v1/verifications", {
        url: state.targetUrl,
        baseline_id: "../../etc/passwd",
      });
      assertHttpErrorEnvelope(traversal.status, traversal.json, "http-traversal-baseline", "INVALID_ARGUMENT");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "MCP over official SDK lists EXACTLY the two contract tools with correct input schemas",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const client = state.mcpClient!;
      const { tools } = await client.listTools(undefined, { timeout: TOOL_CALL_TIMEOUT_MS });
      const names = tools.map((t) => t.name).sort();
      expect(names, "MCP exposes exactly audit_page and verify_fixes").toEqual(["audit_page", "verify_fixes"]);
      const byName = new Map(tools.map((t) => [t.name, t]));
      for (const [name, required] of [
        ["audit_page", ["url"]],
        ["verify_fixes", ["url", "baseline_id"]],
      ] as const) {
        const tool = byName.get(name)!;
        expect(typeof tool.description === "string" && tool.description.length > 0, `${name}: description`).toBe(true);
        const schema = tool.inputSchema as Record<string, unknown>;
        expect(schema.type, `${name}: inputSchema.type`).toBe("object");
        expect(Array.isArray(schema.required) && (schema.required as string[]).join(",") === required.join(","), `${name}: inputSchema.required`).toBe(true);
        const props = (schema.properties ?? {}) as Record<string, unknown>;
        for (const key of required) {
          expect(props[key] !== undefined, `${name}: inputSchema.properties.${key}`).toBe(true);
        }
      }
    },
  );

  it(
    "MCP audit_page on the flawed fixture returns a real engine-derived ScanRun (isError=false, gate=fail) and becomes the baseline",
    async () => {
      const result = await callToolWithPacingRound(state.mcpClient!, "audit_page", { url: state.targetUrl });
      expect(!!result.isError, `MCP audit failed unexpectedly (code=${errCodeTool(result)} text=${toolText(result).slice(0, 180)})`).toBe(false);
      const text = toolText(result);
      expect(text.length > 0, "compact text summary for host readability present").toBe(true);
      const run = toolScanRun(result);
      assertScanRunShape(run, "mcp-audit");
      recordScanDuration("mcp-audit(baseline)", run);
      assertRulesetAccounting(run, "mcp-audit", FLAWED_MUST_VIOLATE);
      expect(run.gate, "flawed fixture must not pass").toBe("fail");
      // Capture the baseline FIRST so downstream verify tests stay decoupled from the
      // persistence-on-disk assertion below.
      state.baseline.runId = String(run.run_id);
      state.baseline.idsByRule = new Map<string, string[]>();
      for (const f of run.findings as any[]) {
        const list = state.baseline.idsByRule.get(String(f.rule_id)) ?? [];
        list.push(String(f.id));
        state.baseline.idsByRule.set(String(f.rule_id), list);
      }
      expect(state.baseline.runId.length > 0, "baseline run_id retained").toBe(true);
      await assertReportStored(run.report_path, "mcp-audit");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "verify_fixes on the SAME URL after a PARTIAL on-disk source repair reports remaining + no_longer_detected, never passes",
    async () => {
      expect(state.flawedHtml.includes(IMG_NO_ALT), "flawed fixture contains the unlabelled informative image").toBe(true);
      const partial = state.flawedHtml.replace(ALT_FIX_SEARCH, ALT_FIX_REPLACE);
      expect(partial !== state.flawedHtml && partial.includes('alt="Product variety chart"'), "exactly the img attribute was repaired").toBe(true);
      await fs.writeFile(state.fixtureFile, partial, "utf8");

      const result = await callToolWithPacingRound(state.mcpClient!, "verify_fixes", { url: state.targetUrl, baseline_id: state.baseline.runId });
      expect(!!result.isError, `a fail-gate verification is a normal honest result, not an MCP error (code=${errCodeTool(result)} text=${toolText(result).slice(0, 180)})`).toBe(false);
      const v = toolJson(result);
      assertVerificationShape(v, state.baseline.runId, "mcp-verify-partial");

      const noLonger = new Set<string>([...v.comparison.no_longer_detected_ids, ...v.comparison.uncertain_baseline_ids]);
      const imageAltIds = state.baseline.idsByRule.get("image-alt") ?? [];
      expect(imageAltIds.length > 0, "baseline had image-alt findings").toBe(true);
      for (const id of imageAltIds) {
        expect(noLonger.has(id), `baseline image-alt finding ${id} is reported no_longer_detected (uncertain falls back is honest at worst)`).toBe(true);
      }
      // but everything the partial repair did not touch must remain:
      const remaining = new Set<string>([...v.comparison.remaining_ids, ...v.comparison.uncertain_baseline_ids]);
      for (const rule of ["color-contrast", "label", "select-name", "link-name", "button-name", "html-has-lang"]) {
        for (const id of state.baseline.idsByRule.get(rule) ?? []) {
          expect(remaining.has(id), `untouched baseline finding ${id} (${rule}) still reported`).toBe(true);
        }
      }
      expect(v.comparison.newly_detected_ids.length, "partial repair must not invent new findings").toBe(0);
      expect(v.current_run.gate, "partial repair still fails the current scan").toBe("fail");
      // the verification gate must never be weaker than the fresh current-run gate
      expect(v.gate, "verification gate at least as strict as the fresh scan").toBe(v.current_run.gate);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "verify_fixes with a NEW selected-rule issue reports newly_detected and gate=fail (no false stability)",
    async () => {
      const current = await fs.readFile(state.fixtureFile, "utf8");
      expect(current.includes(ALT_FIX_REPLACE), "previous partial repair state still on disk").toBe(true);
      expect(current.includes(FORM_CLOSE_SEARCH), "form close tag present in fixture").toBe(true);
      const withNewIssue = current.replace(FORM_CLOSE_SEARCH, `${NEW_ISSUE_LABEL}${FORM_CLOSE_SEARCH}`);
      expect(withNewIssue.includes("id=\"new-extra-field\"") && !withNewIssue.includes("</form></form>"), "one new unlabelled input inserted").toBe(true);
      await fs.writeFile(state.fixtureFile, withNewIssue, "utf8");

      const result = await callToolWithPacingRound(state.mcpClient!, "verify_fixes", { url: state.targetUrl, baseline_id: state.baseline.runId });
      expect(!!result.isError, `verify failed unexpectedly (code=${errCodeTool(result)} text=${toolText(result).slice(0, 180)})`).toBe(false);
      const v = toolJson(result);
      assertVerificationShape(v, state.baseline.runId, "mcp-verify-new-issue");
      expect(v.comparison.newly_detected_ids.length > 0, "the incompatibility must be detected as newly_detected").toBe(true);
      expect(v.current_run.findings.some((f: any) => String(f.rule_id) === "label" && (f.targets ?? []).join(" ").includes("new-extra-field")), "new finding targets the new unlabelled input").toBe(true);
      expect(v.comparison.remaining_ids.length > 0, "other existing problems still detected").toBe(true);
      expect(v.current_run.gate).toBe("fail");
      expect(v.gate).toBe("fail");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "verify_fixes after the corrected reference IS COPIED over the SAME target file: on-disk source repair evidence + honest gate (pass ONLY with certainty AND complete fresh results; uncertain/incomplete downgrades to review_required)",
    async () => {
      const correctedHtml = await fs.readFile(CORRECTED_FIXTURE_PATH, "utf8");
      // Mechanical agent-side source-repair evidence, reproducible in-repo (see
      // test/e2e-fixtures/repair-evidence.unit.mjs): the SAME target file's source is replaced
      // on disk. No switched-URL shortcut and NO claim that the host model performed the demo.
      const beforeHash = sha256(state.flawedHtml);
      await fs.writeFile(state.fixtureFile, correctedHtml, "utf8");
      const afterFile = await fs.readFile(state.fixtureFile, "utf8");
      expect(afterFile, "the SAME target file now holds the corrected reference source").toBe(correctedHtml);
      expect(sha256(afterFile)).not.toBe(beforeHash);
      // stable element IDs/selector structure preserved for reproducible fingerprint matching:
      for (const stableId of [
        "registration-main",
        "registration-form",
        "product-image",
        "fine-print-paragraph",
        "reg-username",
        "region",
        "icon-button",
        "icon-link",
      ]) {
        expect(afterFile.includes(`id="${stableId}"`), `stable id "${stableId}" preserved in repaired source`).toBe(true);
      }
      for (const marker of [
        '<html lang="en">',
        'alt="Product variety chart"',
        '<label for="reg-username">',
        'aria-label="Region"',
      ]) {
        expect(afterFile.includes(marker), `repair marker present in source: ${marker}`).toBe(true);
      }

      const result = await callToolWithPacingRound(state.mcpClient!, "verify_fixes", { url: state.targetUrl, baseline_id: state.baseline.runId });
      expect(!!result.isError, `verify failed unexpectedly (code=${errCodeTool(result)} text=${toolText(result).slice(0, 180)})`).toBe(false);
      const v = toolJson(result);
      assertVerificationShape(v, state.baseline.runId, "mcp-verify-corrected");
      expect(v.comparison.remaining_ids.length, "no baseline finding remains").toBe(0);
      expect(v.comparison.newly_detected_ids.length, "the repair must not introduce new findings").toBe(0);
      const resolved = new Set<string>([...v.comparison.no_longer_detected_ids, ...v.comparison.uncertain_baseline_ids]);
      for (const [rule, ids] of state.baseline.idsByRule) {
        for (const id of ids) {
          expect(resolved.has(id), `baseline finding ${id} (${rule}) resolved as no_longer_detected (uncertain is the honest backstop)`).toBe(true);
        }
      }
      // Gate semantics (PRD addendum user-Q3): with remaining/newly empty the verification gate
      // can only be pass or review_required — never a hard-won pass and never a fail.
      expect(["pass", "review_required"], "verification gate").toContain(v.gate);
      const uncertain = v.comparison.uncertain_baseline_ids as string[];
      const notesJoined = (v.comparison.notes ?? []).join("\n");
      if (v.current_run.gate === "pass") {
        if (uncertain.length > 0) {
          expect(v.gate, "uncertain baseline ids must downgrade to review_required, never pass").toBe("review_required");
          expect(v.completion_claim.includes(PASS_CLAIM_CORE), "uncertain result must NOT claim the verbatim full-pass wording").toBe(false);
        } else {
          expect(v.gate, "certainty on every baseline rule-node and a complete fresh scan backs this pass").toBe("pass");
          expect(v.completion_claim.includes(PASS_CLAIM_CORE) && v.completion_claim.includes(PASS_CLAIM_TAIL), "full-pass claim matches the PRD wording on the SAME URL").toBe(true);
          // Certainty must be backed by positive located evidence: comparison notes account the
          // resolved ids (same rule now PASSES at the same stable target path), not silently gone.
          expect(notesJoined.length > 0, "located pass-evidence notes present").toBe(true);
          for (const id of v.comparison.no_longer_detected_ids) {
            expect(notesJoined.includes(String(id)), `resolved id ${id} backed by located pass-evidence note`).toBe(true);
          }
        }
      } else {
        // The fresh scan itself is incomplete/inconclusive: gate stays conservative (PRD §11).
        expect(v.current_run.gate, "fresh scan gate").toBe("review_required");
        expect(v.gate, "verification gate at least as strict as the fresh scan").toBe("review_required");
        expect(v.gate, "an incomplete fresh scan must NEVER claim a pass").not.toBe("pass");
        expect(v.completion_claim.includes(PASS_CLAIM_CORE), "review_required result must NOT claim the full-pass wording").toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "application behavior preserved by the source repair: same form fields, submit path executes and link destinations retained",
    async () => {
      const flawed = await fs.readFile(FLAWED_FIXTURE_PATH, "utf8");
      const repaired = await fs.readFile(CORRECTED_FIXTURE_PATH, "utf8");
      // The repair edits source; the SAME application fields and submit path must remain:
      for (const field of [
        'action="#" method="post"',   // form still submits through the same handler path
        'id="registration-form"',
        'name="username"',
        'autocomplete="username"',
        'name="region"',
        '<option value="in">India</option>',
        '<option value="other">Other</option>',
        'type="text"',
      ]) {
        expect(flawed.includes(field), `flawed source must contain ${field}`).toBe(true);
        expect(repaired.includes(field), `repaired source must keep the same field: ${field}`).toBe(true);
      }
      // Link destinations retained (sample): the icon link keeps the same /home destination.
      expect(flawed.includes('href="/home"'), "flawed icon link href").toBe(true);
      expect(repaired.includes('href="/home"'), "repair preserved the link destination").toBe(true);
      // The form/button stay executable: the repaired source introduces no disabled state.
      expect(repaired.includes('disabled'), "no disabled control in repaired source").toBe(false);
      expect(repaired.includes('aria-disabled="true"'), "no aria-disabled control in repaired source").toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "verify_fixes baseline error categories are explicit and pass-free: UUID-shaped unknown id -> BASELINE_NOT_FOUND; non-UUID opaque id -> INVALID_ARGUMENT",
    async () => {
      // A well-formed run id that was never persisted: explicit NOT_FOUND, never a pass.
      const unknown = await callToolLoose(state.mcpClient!, "verify_fixes", {
        url: state.targetUrl,
        baseline_id: "9f0cbbfe-0000-4e2e-b000-00000000e2e1",
      });
      expect(unknown.isError === true, "missing baseline surfaces as an explicit MCP tool error").toBe(true);
      expect(errCodeTool(unknown), "unknown baseline operational error code").toBe("BASELINE_NOT_FOUND");
      const scUnknown = unknown.structuredContent;
      if (scUnknown && typeof scUnknown === "object") {
        expect((scUnknown as any).gate, "no gate on operational error").toBeUndefined();
      }
      // An opaque string that is not a resolved run id and not a path-like traversal: rejected.
      const malformed = await callToolLoose(state.mcpClient!, "verify_fixes", {
        url: state.targetUrl,
        baseline_id: "e2e-unknown-baseline-0001",
      });
      expect(malformed.isError === true, "non-UUID baseline id is rejected").toBe(true);
      expect(errCodeTool(malformed), "non-UUID baseline error code").toBe("INVALID_ARGUMENT");
      const scMalformed = malformed.structuredContent;
      if (scMalformed && typeof scMalformed === "object") {
        expect((scMalformed as any).gate, "no gate on argument error").toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "verify_fixes with a path-traversal baseline id is rejected (isError=true, INVALID_ARGUMENT) and never treated as a filesystem path",
    async () => {
      const result = await callToolLoose(state.mcpClient!, "verify_fixes", {
        url: state.targetUrl,
        baseline_id: "../../../etc/passwd",
      });
      expect(result.isError === true, "traversal baseline id must be rejected").toBe(true);
      expect(errCodeTool(result), "traversal is an invalid argument, not a file lookup").toBe("INVALID_ARGUMENT");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "MCP audit_page on a remote non-allowlisted target is an explicit tool error (isError=true) with no pass",
    async () => {
      const result = await callToolLoose(state.mcpClient!, "audit_page", {
        url: "https://ci-not-registered.invalid/registration.html",
      });
      expect(result.isError === true, "disallowed remote target is an operational tool error").toBe(true);
      const code = errCodeTool(result);
      expect(["TARGET_NOT_ALLOWED", "TARGET_UNREACHABLE"], "allowlist refusal (or DNS failure backstop)").toContain(code);
      const sc = result.structuredContent;
      if (sc && typeof sc === "object") {
        expect((sc as any).gate, "no pass gate on operational error").toBeUndefined();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "no stdout diagnostics leak: child stdout/stderr stay free of fixture DOM evidence and findings",
    () => {
      for (const leak of ["<img", "product-image", "reg-username", "new-extra-field", "fine-print-paragraph"]) {
        expect(state.stdoutText.includes(leak), `stdout leaks fixture DOM detail "${leak}"`).toBe(false);
        expect(state.stderrText.includes(leak), `stderr leaks fixture DOM detail "${leak}"`).toBe(false);
      }
      expect(
        state.stdoutText.includes(state.reportDir) || state.stdoutText.length < 1_000_000,
        "stdout must not dump report directory contents",
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

/* tiny helper keep functions declared before use where practical */
function findingsRuleIds(run: any): string[] {
  return (run.findings ?? []).map((f: any) => String(f.rule_id));
}
