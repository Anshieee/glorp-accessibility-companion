import { describe, expect, it } from "vitest";
import {
  EVIDENCE_STATUSES,
  canonicalTarget,
  compactRunFromStored,
  enforceRestrictiveGate,
  gateRank,
  isEvidenceStatus,
  isValidRunId,
  mostRestrictiveGate,
  parseAuditPayload,
  parseTargetUrl,
  parseVerificationPayload,
  stableFindingKey,
  validateStoredScan,
  type Gate,
} from "../src/contracts.js";
import { AppError } from "../src/errors.js";
import { finding, makeStored, reviewItem } from "./fakes.js";

describe("stable finding keys / evidence statuses", () => {
  it("keys are deterministic over rule + targets", () => {
    expect(stableFindingKey("label", ["#a", "#b"])).toBe("label::#a|#b");
    expect(stableFindingKey("label", ["#a", "#b"])).toBe(stableFindingKey("label", ["#a", "#b"]));
    expect(stableFindingKey("label", ["#a"])).not.toBe(stableFindingKey("button-name", ["#a"]));
  });

  it("finding ids equal their stable key in fakes and helpers agree", () => {
    const f = finding({ rule_id: "image-alt", targets: ["img#logo"] });
    expect(f.id).toBe(stableFindingKey("image-alt", ["img#logo"]));
  });

  it("evidence status type guard", () => {
    expect(EVIDENCE_STATUSES).toEqual(["pass", "fail", "incomplete", "missing"]);
    expect(isEvidenceStatus("pass")).toBe(true);
    expect(isEvidenceStatus("unknown")).toBe(false);
  });
});

describe("parseTargetUrl", () => {
  it("accepts absolute http(s) urls", () => {
    expect(parseTargetUrl("https://india.gov.in/a?b=c").toString()).toContain("india.gov.in");
    expect(parseTargetUrl("http://localhost:4173/page").protocol).toBe("http:");
  });

  it("rejects non-strings and malformed urls with INVALID_ARGUMENT", () => {
    for (const bad of [undefined, "", "   ", "not a url", "example.com/page", "/relative"]) {
      expect(() => parseTargetUrl(bad)).toThrowError(AppError);
    }
  });

  it("rejects non-http schemes with TARGET_NOT_ALLOWED", () => {
    try {
      parseTargetUrl("file:///etc/passwd");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("TARGET_NOT_ALLOWED");
    }
  });

  it("rejects embedded credentials with TARGET_NOT_ALLOWED (remote-user confusion)", () => {
    // http://india.gov.in@evil.example is a different host!
    expect(() => parseTargetUrl("http://india.gov.in@evil.example/")).toThrowError(/credentials/);
    expect(() => parseTargetUrl("http://user:pass@india.gov.in/")).toThrowError(/credentials/);
  });

  it("canonicalTarget strips fragments and keeps query", () => {
    expect(canonicalTarget("https://H.example/A#frag")).toBe("https://h.example/A");
    expect(canonicalTarget("https://h.example/A?x=1#frag")).toBe("https://h.example/A?x=1");
  });
});

describe("run id validation", () => {
  it("accepts uuids (case-insensitive) and rejects path-like or other strings", () => {
    expect(isValidRunId("4b3d08e6-8f2b-4d99-bc37-2a0b0ee5b770")).toBe(true);
    expect(isValidRunId("4B3D08E6-8F2B-4D99-BC37-2A0B0EE5B770".toLowerCase())).toBe(true);
    expect(isValidRunId("../etc/passwd")).toBe(false);
    expect(isValidRunId("runs/../../passwords.json")).toBe(false);
    expect(isValidRunId("")).toBe(false);
    expect(isValidRunId(null)).toBe(false);
    expect(isValidRunId("4b3d08e6-8f2b-4d99-bc37-2a0b0ee5b77g")).toBe(false);
  });
});

describe("strict audit payload parsing", () => {
  it("accepts exactly {url}", () => {
    expect(parseAuditPayload({ url: "https://india.gov.in/" })).toEqual({ url: "https://india.gov.in/" });
  });

  it("rejects extras (invalid schema)", () => {
    expect(() => parseAuditPayload({ url: "https://x.example/", extra: 1 })).toThrowError(/no extra fields/);
    expect(() => parseAuditPayload({})).toThrowError(AppError);
    expect(() => parseAuditPayload("https://x.example/")).toThrowError(AppError);
    expect(() => parseAuditPayload(["https://x.example/"])).toThrowError(AppError);
  });

  it("rejects path-like baseline ids in verification payloads", () => {
    expect(() => parseVerificationPayload({ url: "https://x.example/", baseline_id: "../../etc/passwd" })).toThrowError(/run identifier/);
    expect(() => parseVerificationPayload({ url: "https://x.example/", baseline_id: "11111111-2222-3333-4444-555555555555" })).not.toThrow();
    expect(() => parseVerificationPayload({ url: "https://x.example/", baseline_id: "11111111-2222-3333-4444-555555555555", extra: 1 })).toThrowError(/no extra fields/);
  });
});

describe("compactRunFromStored", () => {
  it("truncates returned findings while counts reflect the FULL result", () => {
    const stored = makeStored({
      findings: [
        finding({ rule_id: "label", targets: ["#1"] }),
        finding({ rule_id: "label", targets: ["#2"] }),
        finding({ rule_id: "image-alt", targets: ["img#3"] }),
      ],
    });
    const compact = compactRunFromStored(stored, 2);
    expect(compact.findings).toHaveLength(2);
    expect(compact.counts.violation_node_count).toBe(3); // full
    expect(compact.counts.violation_rule_count).toBe(2); // full (distinct rules)
    expect(compact.counts.returned_finding_count).toBe(2);
    expect(compact.counts.omitted_finding_count).toBe(1);
    expect(compact.details_truncated).toBe(true);
    expect(compact.gate).toBe("fail");
    expect(compact.warnings.some((w) => /omitted/.test(w))).toBe(true);
  });

  it("violations force gate=fail even when the engine claimed otherwise", () => {
    const stored = makeStored({ findings: [finding({ rule_id: "label", targets: ["#1"] })], gateOverride: "pass" });
    stored.run.gate = "pass";
    expect(compactRunFromStored(stored, 100).gate).toBe("fail");
  });

  it("incomplete nodes / review items force review_required; nothing yields pass", () => {
    const reviewOnly = makeStored({
      findings: [],
      reviewItems: [reviewItem({ rule_id: "color-contrast", targets: ["#1"] })],
    });
    expect(compactRunFromStored(reviewOnly, 100).gate).toBe("review_required");

    const pass = makeStored({ findings: [] });
    pass.run.gate = "pass";
    expect(compactRunFromStored(pass, 100).gate).toBe("pass");

    const notEvaluated = makeStored({ findings: [] });
    notEvaluated.run.gate = "not_evaluated";
    expect(compactRunFromStored(notEvaluated, 100).gate).toBe("not_evaluated");
  });

  it("truncates review items and appends a warning when review list is cut", () => {
    const stored = makeStored({
      findings: [],
      reviewItems: [reviewItem({ rule_id: "a", targets: ["#1"] }), reviewItem({ rule_id: "b", targets: ["#2"] })],
    });
    stored.run.counts.incomplete_node_count = 2;
    const compact = compactRunFromStored(stored, 1);
    expect(compact.review_items).toHaveLength(1);
    expect(compact.details_truncated).toBe(true);
    expect(compact.warnings.some((w) => /review item/.test(w))).toBe(true);
  });
});

describe("compactRunFromStored never downgrades the stored engine gate", () => {
  it("stored review_required with no detail arrays (fonts/duplicates/blocked assets) stays review_required", () => {
    const stored = makeStored({ findings: [] });
    stored.run.gate = "review_required";
    expect(compactRunFromStored(stored, 100).gate).toBe("review_required");
  });

  it("stored fail with no full findings retains fail (not pass)", () => {
    const stored = makeStored({ findings: [] });
    stored.run.gate = "fail";
    expect(compactRunFromStored(stored, 100).gate).toBe("fail");
  });

  it("stored not_evaluated stays not_evaluated, even with incomplete counts or review items", () => {
    const bare = makeStored({ findings: [] });
    bare.run.gate = "not_evaluated";
    expect(compactRunFromStored(bare, 100).gate).toBe("not_evaluated");

    const withIncomplete = makeStored({ findings: [] });
    withIncomplete.run.gate = "not_evaluated";
    withIncomplete.run.counts.incomplete_node_count = 3;
    expect(compactRunFromStored(withIncomplete, 100).gate).toBe("not_evaluated");

    const withReview = makeStored({ findings: [], reviewItems: [reviewItem({ rule_id: "a", targets: ["#1"] })] });
    withReview.run.gate = "not_evaluated";
    expect(compactRunFromStored(withReview, 100).gate).toBe("not_evaluated");
  });

  it("stored pass with a real full finding is recomputed to fail", () => {
    const stored = makeStored({ findings: [finding({ rule_id: "label", targets: ["#1"] })] });
    stored.run.gate = "pass";
    expect(compactRunFromStored(stored, 100).gate).toBe("fail");
    expect(compactRunFromStored(stored, 0).gate).toBe("fail");
  });

  it("stored pass with incomplete counts but no arrays becomes review_required", () => {
    const stored = makeStored({ findings: [] });
    stored.run.gate = "pass";
    stored.run.counts.incomplete_node_count = 1;
    expect(compactRunFromStored(stored, 100).gate).toBe("review_required");
  });

  it("an unknown stored gate value is treated as not_evaluated, never pass", () => {
    const stored = makeStored({ findings: [] });
    (stored.run as unknown as { gate: string }).gate = "all-good";
    expect(compactRunFromStored(stored, 100).gate).toBe("not_evaluated");
  });

  it("a stored not_evaluated with real violations resolves to not_evaluated (never a downgrade to fail or pass)", () => {
    const stored = makeStored({ findings: [finding({ rule_id: "label", targets: ["#1"] })] });
    stored.run.gate = "not_evaluated";
    const compact = compactRunFromStored(stored, 100);
    expect(compact.gate).toBe("not_evaluated");
    expect(compact.counts.violation_node_count).toBe(1);
    expect(compact.findings).toHaveLength(1);
  });

  it("a details cap of 0 never implies a clear: review-only and fail stay non-pass", () => {
    const review = makeStored({ findings: [], reviewItems: [reviewItem({ rule_id: "a", targets: ["#1"] })] });
    review.run.gate = "review_required";
    const compactReview = compactRunFromStored(review, 0);
    expect(compactReview.gate).toBe("review_required");
    expect(compactReview.review_items).toHaveLength(0);
    expect(compactReview.details_truncated).toBe(true);
    expect(compactReview.counts.omitted_finding_count).toBe(0);

    const failing = makeStored({ findings: [finding({ rule_id: "label", targets: ["#1"] })] });
    const compactFail = compactRunFromStored(failing, 0);
    expect(compactFail.gate).toBe("fail");
    expect(compactFail.findings).toHaveLength(0);
    expect(compactFail.counts.omitted_finding_count).toBe(1);
    expect(compactFail.counts.violation_node_count).toBe(1);
  });

  it("a normal clean pass still remains pass under a details cap and is not truncated", () => {
    const clean = makeStored({ findings: [] });
    clean.run.gate = "pass";
    const compact = compactRunFromStored(clean, 0);
    expect(compact.gate).toBe("pass");
    expect(compact.details_truncated).toBe(false);
    expect(compact.counts.omitted_finding_count).toBe(0);
  });

  it("invalid caps (negative, NaN, non-number) fall back to 0 without changing gate or full counts", () => {
    const stored = makeStored({
      findings: [finding({ rule_id: "label", targets: ["#1"] }), finding({ rule_id: "label", targets: ["#2"] })],
      reviewItems: [reviewItem({ rule_id: "a", targets: ["#9"] })],
    });
    stored.run.counts.incomplete_node_count = 4;
    for (const bad of [-1, Number.NaN, "5" as unknown as number]) {
      const compact = compactRunFromStored(stored, bad);
      expect(compact.findings).toHaveLength(0);
      expect(compact.review_items).toHaveLength(0);
      expect(compact.gate).toBe("fail");
      expect(compact.counts.violation_node_count).toBe(2);
      expect(compact.counts.omitted_finding_count).toBe(2);
      expect(compact.counts.incomplete_node_count).toBe(4);
      expect(compact.details_truncated).toBe(true);
    }
  });

  it("preserves exact full counts and the stored incomplete count when the view is capped", () => {
    const stored = makeStored({
      findings: [
        finding({ rule_id: "label", targets: ["#1"] }),
        finding({ rule_id: "label", targets: ["#2"] }),
        finding({ rule_id: "image-alt", targets: ["img#3"] }),
      ],
    });
    stored.run.counts.incomplete_node_count = 7;
    const compact = compactRunFromStored(stored, 1);
    expect(compact.counts).toEqual({
      violation_rule_count: 2,
      violation_node_count: 3,
      incomplete_node_count: 7,
      returned_finding_count: 1,
      omitted_finding_count: 2,
    });
  });
});

describe("mostRestrictiveGate", () => {
  it("returns the highest-rank gate and never a less strict one", () => {
    expect(mostRestrictiveGate()).toBe("pass");
    expect(mostRestrictiveGate("pass", "pass")).toBe("pass");
    expect(mostRestrictiveGate("pass", "review_required")).toBe("review_required");
    expect(mostRestrictiveGate("review_required", "fail")).toBe("fail");
    expect(mostRestrictiveGate("fail", "pass")).toBe("fail");
    expect(mostRestrictiveGate("pass", "not_evaluated")).toBe("not_evaluated");
    expect(mostRestrictiveGate("fail", "not_evaluated")).toBe("not_evaluated");
  });

  it("is order independent", () => {
    const gates: Gate[] = ["pass", "fail", "review_required", "not_evaluated"];
    for (const a of gates) {
      for (const b of gates) {
        expect(mostRestrictiveGate(a, b)).toBe(mostRestrictiveGate(b, a));
      }
    }
  });
});

describe("gate restrictiveness", () => {
  it("ranks pass < review_required < fail < not_evaluated", () => {
    expect(gateRank("pass")).toBeLessThan(gateRank("review_required"));
    expect(gateRank("review_required")).toBeLessThan(gateRank("fail"));
    expect(gateRank("fail")).toBeLessThan(gateRank("not_evaluated"));
  });

  it("enforceRestrictiveGate never upgrades a fail to pass", () => {
    const v = { gate: "pass" } as unknown as Parameters<typeof enforceRestrictiveGate>[0];
    expect(enforceRestrictiveGate(v, "fail").gate).toBe("fail");
    const w = { gate: "fail" } as unknown as Parameters<typeof enforceRestrictiveGate>[0];
    expect(enforceRestrictiveGate(w, "pass").gate).toBe("fail");
    const x = { gate: "pass" } as unknown as Parameters<typeof enforceRestrictiveGate>[0];
    expect(enforceRestrictiveGate(x, "not_evaluated").gate).toBe("not_evaluated");
  });
});

describe("validateStoredScan", () => {
  it("accepts an internally consistent stored scan and rejects tampered ones", () => {
    const stored = makeStored({ findings: [finding({ rule_id: "label", targets: ["#f1"] })] });
    expect(validateStoredScan(stored)).not.toBeNull();
    const wrongId = JSON.parse(JSON.stringify(stored));
    wrongId.run.run_id = "not-a-uuid";
    expect(validateStoredScan(wrongId)).toBeNull();
    const noEvidence = JSON.parse(JSON.stringify(stored));
    delete noEvidence.evidence;
    expect(validateStoredScan(noEvidence)).toBeNull();
    const badEvidence = JSON.parse(JSON.stringify(stored));
    badEvidence.evidence = { "label::#f1": "yes-ish" };
    expect(validateStoredScan(badEvidence)).toBeNull();
    const badFinding = JSON.parse(JSON.stringify(stored));
    badFinding.full_findings[0].guidance_source = "made_up";
    expect(validateStoredScan(badFinding)).toBeNull();
  });

  it("accepts a rule-level incomplete ReviewItem with empty targets (no node evidence)", () => {
    const stored = makeStored({
      findings: [],
      reviewItems: [reviewItem({ rule_id: "color-contrast", targets: [] })],
    });
    expect(validateStoredScan(stored)).not.toBeNull();
  });

  it("rule-level incomplete with empty targets compacts to review_required (never pass), counts intact", () => {
    const stored = makeStored({
      findings: [],
      reviewItems: [reviewItem({ rule_id: "color-contrast", targets: [] })],
    });
    stored.run.counts.incomplete_node_count = 0;
    const compact = compactRunFromStored(stored, 100);
    expect(compact.gate).toBe("review_required");
    expect(compact.review_items).toHaveLength(1);
    expect(compact.counts.incomplete_node_count).toBe(0);
  });

  it("still rejects invalid ReviewItem targets (null/object/numeric/mixed) and keeps Finding.targets non-empty", () => {
    for (const badTargets of [null, {}, "x", [null], [123], ["#ok", 7], ["#ok", ""], [""], undefined]) {
      const stored = makeStored({ findings: [] });
      (stored.full_review_items as unknown[]).push({ rule_id: "label", reason: "needs review", html: null, targets: badTargets });
      stored.run.review_items = stored.full_review_items as never;
      expect(validateStoredScan(stored)).toBeNull();
    }
    // Finding with empty targets is still invalid.
    const badFinding = makeStored({ findings: [] });
    (badFinding.full_findings as unknown[]).push({ ...finding({ rule_id: "label", targets: ["#x"] }), targets: [] });
    expect(validateStoredScan(badFinding)).toBeNull();
  });
});
