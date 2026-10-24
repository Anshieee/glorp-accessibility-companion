/**
 * Comparator (engine worker).
 *
 * compareRuns(baseline, current) => VerificationResult.
 *
 * - Baseline is NEVER mutated (inputs are treated as immutable records).
 * - Comparable conditions: requested canonical URL (no fragment), final URL
 *   (no fragment), viewport, color scheme, browser locale, readiness policy,
 *   scope, engine rule_ids, ruleset fingerprint and engine versions. Anything
 *   differs → BASELINE_INCOMPATIBLE explaining the exact differing conditions
 *   (PRD §12.1).
 * - Conservative delta semantics (PRD §12.2): stable matching over the shared
 *   rule/target fingerprint ids; current PASS evidence at the same stable
 *   target upgrades a disappeared baseline issue to "no longer detected" with
 *   extra evidence; an absent finding is NOT proven fixed — it becomes
 *   uncertain and forces review unless the current scan already fails for in a
 *   other way (fail is highest). Removing DOM never creates forced certainty.
 */
import { AppError } from "./errors.js";
import {
  type Gate,
  type ScanRun,
  type StoredScan,
  type VerificationResult,
} from "./contracts.js";
import {
  PASS_COMPLETION_CLAIM,
  NOT_EVALUATED_COMPLETION_CLAIM,
  REVIEW_REQUIRED_COMPLETION_CLAIM,
} from "./scanner.js";

export const UNCERTAIN_NOTE =
  "Could not be re-evaluated at its previous target in the fresh scan. Disappearance is not proof of repair: the element may have been removed, hidden, renamed or moved. Removed DOM is not forced certainty.";

const UNCERTAIN_UNSUPPORTED_NOTE =
  "No pass evidence exists for this target in the fresh scan, so the earlier finding cannot be marked fixed from automated evidence alone.";

function canonicalizeUrl(raw: unknown, label: string): string {
  let url: string;
  if (typeof raw !== "string") {
    throw new AppError(
      "BASELINE_INCOMPATIBLE",
      `Baseline is not comparable: the stored ${label} is not a valid URL.`,
      "Create a new baseline with a fresh audit, then verify again.",
      false,
    );
  }
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    throw new AppError(
      "BASELINE_INCOMPATIBLE",
      `Baseline is not comparable: the stored ${label} could not be parsed as a URL.`,
      "Create a new baseline with a fresh audit, then verify again.",
      false,
    );
  }
}

function describeConditions(run: ScanRun): string[] {
  return [
    `viewport=${run.conditions.viewport.width}x${run.conditions.viewport.height}`,
    `color_scheme=${run.conditions.color_scheme}`,
    `browser_locale=${run.conditions.browser_locale}`,
    `readiness=${run.conditions.readiness_selector ?? "(none)"}`,
    `scope=${run.conditions.scope}`,
    `rule_ids=${[...run.engine.rule_ids].sort().join("+")}`,
    `ruleset_fingerprint=${run.engine.ruleset_fingerprint}`,
    `axe_version=${run.engine.axe_version}`,
    `playwright_version=${run.engine.playwright_version}`,
  ];
}

function sameRuleIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}

/**
 * Conservative verification. Throws BASELINE_INCOMPATIBLE when conditions or
 * the requested/final canonical URLs differ; returns honest comparison deltas
 * with a gate at least as restrictive as the current scan's gate.
 */
export function compareRuns(baseline: StoredScan, current: StoredScan): VerificationResult {
  const diffs: string[] = [];

  const baselineRequested = canonicalizeUrl(baseline.run.requested_url, "requested_url");
  const currentRequested = canonicalizeUrl(current.run.requested_url, "requested_url");
  if (baselineRequested !== currentRequested) diffs.push("requested canonical URL");

  const baselineFinal = canonicalizeUrl(baseline.run.final_url, "final_url");
  const currentFinal = canonicalizeUrl(current.run.final_url, "final_url");
  if (baselineFinal !== currentFinal) diffs.push("final URL after redirects");

  const b = baseline.run;
  const c = current.run;
  if (b.conditions.viewport.width !== c.conditions.viewport.width || b.conditions.viewport.height !== c.conditions.viewport.height) {
    diffs.push("viewport");
  }
  if (b.conditions.color_scheme !== c.conditions.color_scheme) diffs.push("color scheme");
  if (b.conditions.browser_locale !== c.conditions.browser_locale) diffs.push("browser locale");
  if ((b.conditions.readiness_selector ?? null) !== (c.conditions.readiness_selector ?? null)) diffs.push("readiness policy");
  if (b.conditions.scope !== c.conditions.scope) diffs.push("scan scope");
  if (!sameRuleIds(b.engine.rule_ids, c.engine.rule_ids)) diffs.push("engine rule ids");
  if (b.engine.ruleset_fingerprint !== c.engine.ruleset_fingerprint) diffs.push("engine ruleset fingerprint");
  if (b.engine.axe_version !== c.engine.axe_version) diffs.push("axe engine version");
  if (b.engine.playwright_version !== c.engine.playwright_version) diffs.push("playwright engine version");

  if (diffs.length > 0) {
    throw new AppError(
      "BASELINE_INCOMPATIBLE",
      `Baseline is not comparable with the requested scan. Differing conditions: ${diffs.join(", ")}. Baseline(${describeConditions(b).join(", ")}) vs current(${describeConditions(c).join(", ")}).`,
      "Create a new baseline with a fresh audit after an engine/condition change, then run verification again. Do not compare unrelated routes or environments.",
      false,
    );
  }

  const baselineIds = new Set<string>();
  for (const f of baseline.full_findings) baselineIds.add(f.id);

  const currentEvidence = current.evidence ?? {};
  const currentFindingIds = new Set<string>();
  for (const f of current.full_findings) currentFindingIds.add(f.id);

  const remainingIds: string[] = [];
  const noLongerDetectedIds: string[] = [];
  const uncertainBaselineIds: string[] = [];
  const notes: string[] = [];

  for (const id of baselineIds) {
    const status = currentEvidence[id];
    if (status === "fail" || status === "incomplete") {
      remainingIds.push(id);
      notes.push(
        `${id}: still present in the current scan (${status}). Automated detection ran again at the same stable rule/target path.`,
      );
    } else if (status === "pass") {
      noLongerDetectedIds.push(id);
      notes.push(
        `${id}: the same engine rule now PASSES at the same stable target path in the current scan, so the disappearance is supported by positive engine evidence (not merely by the finding being gone).`,
      );
    } else {
      uncertainBaselineIds.push(id);
      notes.push(`${id}: ${UNCERTAIN_NOTE} ${UNCERTAIN_UNSUPPORTED_NOTE}`);
    }
  }

  const newlyDetectedIds: string[] = [];
  for (const id of currentFindingIds) {
    if (!baselineIds.has(id)) newlyDetectedIds.push(id);
  }
  if (newlyDetectedIds.length > 0) {
    notes.push(
      `${newlyDetectedIds.length} newly detected violation(s) with no matching baseline finding; new problems block the verification gate (fail outranks review).`,
    );
  }

  // Gate: at least as restrictive as current_run.gate; uncertain disappearances
  // force review_required only when the scan itself would otherwise pass (a
  // current fail or not_evaluated result keeps a higher gate rank).
  let gate: Gate = c.gate;
  if (uncertainBaselineIds.length > 0 && c.gate === "pass") {
    gate = "review_required";
  }

  const completionClaim = completionClaimFor(gate);

  const sorted = (xs: string[]): string[] => [...xs].sort();
  return {
    schema_version: "1.0",
    baseline_id: b.run_id,
    current_run: c,
    comparison: {
      comparable: true,
      remaining_ids: sorted(remainingIds),
      newly_detected_ids: sorted(newlyDetectedIds),
      no_longer_detected_ids: sorted(noLongerDetectedIds),
      uncertain_baseline_ids: sorted(uncertainBaselineIds),
      notes,
    },
    gate,
    completion_claim: completionClaim,
  };
}

/** Deterministic completion claim per final verification gate (PRD §11/§12). */
function completionClaimFor(gate: Gate): string {
  switch (gate) {
    case "pass":
      return PASS_COMPLETION_CLAIM;
    case "review_required":
      return REVIEW_REQUIRED_COMPLETION_CLAIM;
    case "fail":
      return (
        "Blocked: the fresh scan of the same URL still reports selected-rule violations. Fix remaining findings and run verification again."
      );
    case "not_evaluated":
      return NOT_EVALUATED_COMPLETION_CLAIM;
  }
}
