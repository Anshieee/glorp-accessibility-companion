/**
 * Comparator unit tests on synthetic StoredScan records (allowed by PRD §19 —
 * synthetic engine output is for deterministic comparator cases only; the
 * real browser evidence lives in scanner.test.ts).
 */
import { describe, expect, it, } from "vitest";
import { compareRuns } from "../src/compare.js";
import { findingIdFor } from "../src/normalize.js";
import type { Finding, ScanRun, StoredScan } from "../src/contracts.js";
import { AppError } from "../src/errors.js";

const BASE_URL = "http://127.0.0.1:4173/fixtures/registration.html";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function finding(ruleId: string, targets: string[], extra: Partial<Finding> = {}): Finding {
  const id = findingIdFor(ruleId, targets);
  return {
    id,
    rule_id: ruleId,
    impact: "serious",
    description: `${ruleId} failed`,
    help: `Fix ${ruleId}`,
    help_url: "https://example.invalid/rules/" + ruleId,
    wcag_tags: ["wcag2a"],
    targets,
    html: `<div data-testid="node">${ruleId}</div>`,
    failure_summary: null,
    guidance: `Deterministic guidance for ${ruleId}; preserve behavior.`,
    guidance_source: "rule_registry",
    requires_context: false,
    ...extra,
  };
}

function makeRun(overrides: Partial<ScanRun> = {}): ScanRun {
  return {
    schema_version: "1.0",
    run_id: "11111111-2222-4333-8444-555555555555",
    execution: "completed",
    started_at: "2026-10-24T10:00:00.000Z",
    completed_at: "2026-10-24T10:00:03.000Z",
    duration_ms: 3_000,
    requested_url: BASE_URL,
    final_url: BASE_URL,
    page_title: "Registration",
    conditions: {
      viewport: { width: 1280, height: 800 },
      color_scheme: "light",
      browser_locale: "en-US",
      readiness_selector: null,
      scope: "full_page",
    },
    engine: {
      axe_version: "4.14.0",
      playwright_version: "1.64.1",
      rule_ids: ["color-contrast", "image-alt", "label", "select-name", "link-name", "button-name", "html-has-lang", "html-lang-valid"],
      ruleset_fingerprint: "f".repeat(64),
    },
    coverage: {
      categories: ["Form labels"],
      evaluated_rule_ids: ["label"],
      inapplicable_rule_ids: ["image-alt"],
      incomplete_rule_ids: [],
      current_rendered_state_only: true,
      frame_coverage: "main_document_only",
    },
    counts: {
      violation_rule_count: 1,
      violation_node_count: 1,
      incomplete_node_count: 0,
      returned_finding_count: 1,
      omitted_finding_count: 0,
    },
    findings: [],
    review_items: [],
    gate: "fail",
    details_truncated: false,
    report_path: "runs/11111111-2222-4333-8444-555555555555.json",
    warnings: [],
    limitations: ["Automated subset only."],
    ...overrides,
  };
}

const TARGET_FULLNAME = ["html > body > form > div.field > input#reg-fullname"];
const TARGET_IMG = ["html > body > main > img"];
const TARGET_REMOVED = ["html > body > main > section#old-thing"];

function stored(run: ScanRun, findings: Finding[], evidence: Record<string, "pass" | "fail" | "incomplete">, reviewItems: StoredScan["full_review_items"] = []): StoredScan {
  return deepFreeze({ run, full_findings: findings, full_review_items: reviewItems, evidence }) as StoredScan;
}

const contrastTarget = ["html > body > main > p.intro"];
const CONTRAST_ID = findingIdFor("color-contrast", contrastTarget);
const IMG_ID = findingIdFor("image-alt", TARGET_IMG);

describe("compareRuns: conservative delta semantics", () => {
  it("unchanged issue: remaining and failed gate", () => {
    const baseline = stored(makeRun(), [finding("color-contrast", contrastTarget)], { [CONTRAST_ID]: "fail" });
    const current = stored(makeRun(), [finding("color-contrast", contrastTarget)], { [CONTRAST_ID]: "fail" });
    const v = compareRuns(baseline, current);
    expect(v.comparison.comparable).toBe(true);
    expect(v.comparison.remaining_ids).toEqual([CONTRAST_ID]);
    expect(v.comparison.newly_detected_ids).toHaveLength(0);
    expect(v.comparison.uncertain_baseline_ids).toHaveLength(0);
    expect(v.gate).toBe("fail");
  });

  it("baseline finding now passes at the SAME stable target: no longer detected with pass evidence", () => {
    const baseline = stored(makeRun(), [finding("color-contrast", contrastTarget)], { [CONTRAST_ID]: "fail" });
    // Current scan: same element passes; evidence includes pass nodes.
    const current = stored(makeRun({ gate: "pass", findings: [], counts: { ...makeRun().counts, violation_node_count: 0, returned_finding_count: 0 } }), [], { [CONTRAST_ID]: "pass" });
    const v = compareRuns(baseline, current);
    expect(v.comparison.no_longer_detected_ids).toEqual([CONTRAST_ID]);
    expect(v.comparison.remaining_ids).toHaveLength(0);
    expect(v.comparison.uncertain_baseline_ids).toHaveLength(0);
    expect(v.gate).toBe("pass");
    expect(v.completion_claim).toContain("No violations detected by the selected automated checks");
  });

  it("absent finding is uncertain + review — removing DOM is not proof of repair", () => {
    const baseline = stored(makeRun(), [finding("color-contrast", TARGET_REMOVED)], { [findingIdFor("color-contrast", TARGET_REMOVED)]: "fail" });
    const current = stored(makeRun({ gate: "pass", counts: { ...makeRun().counts, violation_node_count: 0 } }), [], { [IMG_ID]: "pass" });
    const v = compareRuns(baseline, current);
    expect(v.comparison.uncertain_baseline_ids).toEqual([findingIdFor("color-contrast", TARGET_REMOVED)]);
    expect(v.comparison.no_longer_detected_ids).toHaveLength(0);
    // Uncertainty downgrades an otherwise-passing scan to review_required.
    expect(v.gate).toBe("review_required");
    expect(v.completion_claim).not.toContain("No violations detected by the selected automated checks on the tested page state.");
  });

  it("newly detected violation → fail (fail outranks everything in the delta)", () => {
    const baseline = stored(makeRun(), [], { [IMG_ID]: "pass" });
    const current = stored(
      makeRun({ run_id: "99999999-2222-4333-8444-555555555555" }),
      [finding("image-alt", TARGET_IMG)],
      { [IMG_ID]: "fail" },
    );
    const v = compareRuns(baseline, current);
    expect(v.comparison.newly_detected_ids).toEqual([IMG_ID]);
    expect(v.gate).toBe("fail");
  });

  it("incomplete current result on same target stays 'remaining' and review_required", () => {
    const baseline = stored(makeRun(), [finding("label", TARGET_FULLNAME)], { [findingIdFor("label", TARGET_FULLNAME)]: "fail" });
    const current = stored(
      makeRun({ gate: "review_required", counts: { ...makeRun().counts, violation_node_count: 0, incomplete_node_count: 1 } }),
      [],
      { [findingIdFor("label", TARGET_FULLNAME)]: "incomplete" },
      [{ rule_id: "label", targets: TARGET_FULLNAME, reason: "Could not conclude", html: null }],
    );
    const v = compareRuns(baseline, current);
    expect(v.comparison.remaining_ids).toEqual([findingIdFor("label", TARGET_FULLNAME)]);
    expect(v.gate).toBe("review_required");
  });

  it("current fail gate is never relaxed by comparing", () => {
    const baseline = stored(makeRun(), [finding("color-contrast", contrastTarget)], { [CONTRAST_ID]: "fail" });
    const current = stored(
      makeRun({ gate: "fail" }),
      [finding("color-contrast", contrastTarget)],
      { [CONTRAST_ID]: "fail", [IMG_ID]: "pass" },
    );
    const v = compareRuns(baseline, current);
    expect(v.gate).toBe("fail");
  });
});

describe("compareRuns: comparability enforcement", () => {
  function incompatible(baselineOverrides: Partial<ScanRun>, currentOverrides: Partial<ScanRun>): AppError {
    try {
      compareRuns(
        stored(makeRun(baselineOverrides), [], { [CONTRAST_ID]: "pass" }),
        stored(makeRun(currentOverrides), [], { [CONTRAST_ID]: "pass" }),
      );
      throw new Error("expected BASELINE_INCOMPATIBLE");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      return err as AppError;
    }
  }

  it("rejects different requested URLs (canonical, fragment ignored)", () => {
    const err = incompatible({}, { requested_url: "http://127.0.0.1:4173/fixtures/other.html" });
    expect(err.code).toBe("BASELINE_INCOMPATIBLE");
    expect(err.message).toContain("requested canonical URL");
  });

  it("fragment-only difference is still comparable", () => {
    const baseline = stored(makeRun({ requested_url: `${BASE_URL}#top`, final_url: BASE_URL }), [], { [CONTRAST_ID]: "pass" });
    const current = stored(makeRun(), [], { [CONTRAST_ID]: "pass" });
    const v = compareRuns(baseline, current);
    expect(v.comparison.comparable).toBe(true);
  });

  it("rejects different final URLs", () => {
    const err = incompatible({}, { requested_url: `${BASE_URL}#top`, final_url: "http://127.0.0.1:4173/fixtures/corrected.html" });
    expect(err.code).toBe("BASELINE_INCOMPATIBLE");
    expect(err.message).toContain("final URL");
  });

  it("rejects differing viewport / locale / readiness / fingerprint / versions / rule ids", () => {
    expect(incompatible({}, { conditions: { ...makeRun().conditions, viewport: { width: 375, height: 667 } } }).message).toContain("viewport");
    expect(incompatible({}, { conditions: { ...makeRun().conditions, browser_locale: "de-DE" } }).message).toContain("browser locale");
    expect(incompatible({}, { conditions: { ...makeRun().conditions, readiness_selector: "#ready" } }).message).toContain("readiness");
    expect(incompatible({}, { engine: { ...makeRun().engine, ruleset_fingerprint: "a".repeat(64) } }).message).toContain("ruleset fingerprint");
    expect(incompatible({}, { engine: { ...makeRun().engine, axe_version: "4.10.2" } }).message).toContain("axe");
    expect(incompatible({}, { engine: { ...makeRun().engine, rule_ids: ["label"] } }).message).toContain("rule ids");
  });

  it("never mutates the baseline (deep-frozen inputs survive a full comparison)", () => {
    const baseline = stored(makeRun(), [finding("color-contrast", contrastTarget)], { [CONTRAST_ID]: "fail" });
    const current = stored(makeRun({ gate: "pass" }), [], { [CONTRAST_ID]: "pass" });
    expect(() => compareRuns(baseline, current)).not.toThrow();
  });
});
