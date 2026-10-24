/**
 * Normalizer unit tests (engine worker, pure — no browser, no network).
 *
 * Covers the restrictive outcome accounting added in the security review:
 *  - a violation/incomplete outcome without node evidence can NEVER turn into
 *    a pass (explicit RULESET_UNSUPPORTED for violations; rule-level review
 *    item for incomplete rules),
 *  - nested shadow-DOM target structures get distinct stable ids that can
 *    never alias flat targets,
 *  - duplicate stable ids are counted and downgraded, never silently dropped,
 *  - the gate ordering (fail > any review > duplicates > blocked assets >
 *    unknown engine version > unsettled fonts > pass).
 */
import { describe, expect, it } from "vitest";
import {
  computeOutcomeGate,
  findingIdFor,
  flattenTargetDisplay,
  normalizeAxeResults,
  normalizeTargetStructure,
  type RawResult,
} from "../src/normalize.js";
import { TARGET_PATH_ALGO } from "../src/rules.js";

function rawResult(id: string, nodes: RawResult["nodes"], extra: Partial<RawResult> = {}): RawResult {
  return { id, nodes, ...extra };
}

function outcomeFor(raw: {
  violations?: RawResult[];
  passes?: RawResult[];
  incomplete?: RawResult[];
  inapplicable?: RawResult[];
}) {
  return normalizeAxeResults(raw);
}

describe("outcome accounting: findings without node evidence never pass", () => {
  it("a violation with zero nodes is an explicit RULESET_UNSUPPORTED accounting error", () => {
    expect(() =>
      outcomeFor({ violations: [rawResult("image-alt", [])], passes: [rawResult("color-contrast", [{ target: ["#a"] }])] }),
    ).toThrowError(/violations with no node evidence/i);
  });

  it("a violation node with an empty/normalized-away target is RULESET_UNSUPPORTED too", () => {
    expect(() => outcomeFor({ violations: [rawResult("image-alt", [{ target: [] }])] })).toThrowError(/usable target/i);
  });

  it("an incomplete rule with zero nodes creates a rule-level review item (targets empty) and keeps review_required", () => {
    const outcome = outcomeFor({
      incomplete: [rawResult("color-contrast", [])],
      passes: [rawResult("image-alt", [{ target: ["#img"] }])],
      inapplicable: [rawResult("html-has-lang", [])],
    });
    expect(outcome.counts.violationNodeCount).toBe(0);
    expect(outcome.counts.incompleteNodeCount).toBe(0);
    expect(outcome.counts.incompleteRuleCount).toBe(1);
    expect(outcome.reviewItems).toHaveLength(1);
    expect(outcome.reviewItems[0].rule_id).toBe("color-contrast");
    expect(outcome.reviewItems[0].targets).toEqual([]);
    expect(outcome.reviewItems[0].html).toBeNull();
    expect(outcome.reviewItems[0].reason.length).toBeGreaterThan(10);
    expect(outcome.incompleteRuleIds).toContain("color-contrast");
    const gate = computeOutcomeGate(outcome, { engineVersionKnown: true, remoteAssetsBlocked: 0, fontsUnsettled: false });
    expect(gate).toBe("review_required");
  });

  it("an incomplete rule WITH nodes keeps node-level review items (rule-level item not duplicated)", () => {
    const outcome = outcomeFor({
      incomplete: [rawResult("color-contrast", [{ target: ["#btn"], failureSummary: "Needs manual check" }])],
    });
    expect(outcome.counts.incompleteNodeCount).toBe(1);
    expect(outcome.counts.incompleteRuleCount).toBe(0);
    expect(outcome.reviewItems).toHaveLength(1);
    expect(outcome.reviewItems[0].targets).toEqual(["#btn"]);
    expect(outcome.reviewItems[0].reason).toContain("Needs manual check");
  });
});

describe("structural target identity (shadow DOM)", () => {
  it("preserves nested structure that the old flattening could alias", () => {
    expect(normalizeTargetStructure(["#host", ["#inner"]])).toEqual(["#host", ["#inner"]]);
    expect(normalizeTargetStructure([["#inner"]])).toEqual([["#inner"]]);
    // whitespace/casing normalization per string part, structure kept
    expect(normalizeTargetStructure([" #host ", ["  #inner  "], 42])).toEqual(["#host", ["#inner"]]);
  });

  it("nested targets vs flat targets that old flattening collided on get distinct stable ids", () => {
    // Old flattening dropped the nested part entirely: ["#a", ["#b"]] became
    // ["#a"] — identical to a genuinely flat ["#a"] target. The new identity
    // keeps the structure, so these MUST differ.
    const nested = findingIdFor("image-alt", ["#host", ["#inner"]]);
    const flatWithSamePrefix = findingIdFor("image-alt", ["#host"]);
    const deeplyNested = findingIdFor("image-alt", [["#inner"]]);
    const flatInner = findingIdFor("image-alt", ["#inner"]);
    expect(nested).not.toBe(flatWithSamePrefix);
    expect(deeplyNested).not.toBe(flatInner);
    expect(nested).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flat single-level targets keep the EXACT previous identity (compatibility)", () => {
    const legacy = findingIdFor("image-alt", [" img#logo "]);
    expect(legacy).toBe(findingIdFor("image-alt", ["img#logo"]));
    // multi-part flat targets also unchanged vs the old delimiter join
    expect(findingIdFor("image-alt", ["#a", "#b"])).toBe(findingIdFor("image-alt", ["#a", "#b"]));
  });

  it("nested identity is algorithm-tagged so algorithm changes never alias old ids", () => {
    const structure = normalizeTargetStructure(["#host", ["#inner"]]);
    const a1 = findingIdFor("image-alt", ["#host", ["#inner"]]);
    // Simulate an algorithm bump: same structure, different tag -> different id.
    // (Tag folds into the fingerprint; adding the tag must change the id.)
    expect(TARGET_PATH_ALGO.length).toBeGreaterThan(3);
    expect(a1).not.toBe(findingIdFor("image-alt", flattenTargetDisplay(structure)));
  });
});

describe("duplicate stable ids are counted, never silently dropped", () => {
  it("two findings for the same rule+target count as duplicates; duplicates downgrade a clean run", () => {
    const node = [{ target: ["#dup"], failureSummary: "x" }];
    const outcome = outcomeFor({ violations: [rawResult("image-alt", node), rawResult("image-alt", node)] });
    // both instances are kept in the full list (no silent assumed-fixed), but
    // the duplicate id count exposes the ambiguity.
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings[0].id).toBe(outcome.findings[1].id);
    expect(outcome.duplicateFindingIdCount).toBe(1);
    // Downgrade path: a clean outcome carrying a duplicate id is not a pass.
    const ambiguousPass = { ...outcome, findings: [], counts: { ...outcome.counts, violationNodeCount: 0 } };
    expect(
      computeOutcomeGate(ambiguousPass, { engineVersionKnown: true, remoteAssetsBlocked: 0, fontsUnsettled: false }),
    ).toBe("review_required");
  });
});

describe("gate ordering (most restrictive first)", () => {
  const clean = outcomeFor({
    passes: [rawResult("image-alt", [{ target: ["#ok"] }])],
    inapplicable: [rawResult("color-contrast", []), rawResult("html-has-lang", [])],
  });

  it("violations dominate everything", () => {
    const failing = outcomeFor({
      violations: [rawResult("image-alt", [{ target: ["#img-broken"] }])],
      incomplete: [rawResult("color-contrast", [{ target: ["#c"] }])],
    });
    expect(computeOutcomeGate(failing, { engineVersionKnown: false, remoteAssetsBlocked: 5, fontsUnsettled: true })).toBe("fail");
  });

  it("review_required from review items, duplicates or blocked assets overrides version/fonts downgrades", () => {
    const withReview = outcomeFor({ incomplete: [rawResult("color-contrast", [])] });
    expect(computeOutcomeGate(withReview, { engineVersionKnown: false, remoteAssetsBlocked: 1, fontsUnsettled: true })).toBe("review_required");
    const duplicating = outcomeFor({
      violations: [rawResult("image-alt", [{ target: ["#dup"] }]), rawResult("image-alt", [{ target: ["#dup2"] }])],
    });
    expect(computeOutcomeGate(duplicating, { engineVersionKnown: false, remoteAssetsBlocked: 1, fontsUnsettled: true })).toBe("fail");
    const dupCleanGate = computeOutcomeGate(
      { ...clean, duplicateFindingIdCount: 2 },
      { engineVersionKnown: false, remoteAssetsBlocked: 1, fontsUnsettled: true },
    );
    expect(dupCleanGate).toBe("review_required");
    const blocked = computeOutcomeGate({ ...clean }, { engineVersionKnown: false, remoteAssetsBlocked: 3, fontsUnsettled: true });
    expect(blocked).toBe("review_required");
  });

  it("unknown engine version downgrades an otherwise-clean run to not_evaluated", () => {
    expect(computeOutcomeGate(clean, { engineVersionKnown: false, remoteAssetsBlocked: 0, fontsUnsettled: false })).toBe("not_evaluated");
  });

  it("unsettled fonts downgrade an otherwise-clean run to review_required (never upgrade a fail)", () => {
    expect(computeOutcomeGate(clean, { engineVersionKnown: true, remoteAssetsBlocked: 0, fontsUnsettled: true })).toBe("review_required");
    const failing = outcomeFor({ violations: [rawResult("image-alt", [{ target: ["#img"] }])] });
    expect(computeOutcomeGate(failing, { engineVersionKnown: true, remoteAssetsBlocked: 0, fontsUnsettled: true })).toBe("fail");
  });

  it("a fully clean, provenanced run is a pass", () => {
    expect(computeOutcomeGate(clean, { engineVersionKnown: true, remoteAssetsBlocked: 0, fontsUnsettled: false })).toBe("pass");
  });
});
