/**
 * Service layer: audit (scan + persist + compact response) and verify
 * (load baseline → comparable-conditions precheck → fresh scan → persist →
 * compact → compare → restrictive-gate enforcement aligned with claim).
 * Exactly one scan active at a time (SCAN_BUSY otherwise). compareRuns is
 * injected (engine module) so this unit is fully testable with a fake engine
 * and fake comparator.
 *
 * Every audit/verify call has a service-level deadline (default 45s) covering
 * baseline load, scan and persistence. On timeout the caller gets SCAN_TIMEOUT
 * immediately, but the underlying work is not abandoned: it keeps the single
 * scan slot until it settles. Each await is followed by a deadline check so
 * late work cannot start a scan, persist a result, or return one.
 */
import type {
  Gate,
  RunStore,
  ScanEngine,
  ScanRun,
  StoredScan,
  VerificationResult,
} from "./contracts.js";
import {
  compactRunFromStored,
  canonicalTarget,
  validateRunId,
  parseTargetUrl,
  enforceRestrictiveGate,
} from "./contracts.js";
import { AppError } from "./errors.js";
import {
  PASS_COMPLETION_CLAIM,
  NOT_EVALUATED_COMPLETION_CLAIM,
  REVIEW_REQUIRED_COMPLETION_CLAIM,
} from "./scanner.js";

export type CompareRuns = (baseline: StoredScan, current: StoredScan) => VerificationResult;

export interface ServiceOptions {
  engine: ScanEngine;
  store: RunStore;
  /** From compare.ts (engine worker): compareRuns(baseline,current) => VerificationResult. */
  compareRuns: CompareRuns;
  maxFindings: number;
  /**
   * Whole-invocation deadline for audit/verify (baseline load + scan + persist).
   * Positive finite ms, at most 2^31-1 (setTimeout limit). Defaults to 45s.
   */
  invocationTimeoutMs?: number;
}

const DEFAULT_INVOCATION_TIMEOUT_MS = 45_000;
const MAX_TIMER_MS = 2_147_483_647;

function invocationTimeoutError(): AppError {
  return new AppError(
    "SCAN_TIMEOUT",
    "The audit or verification exceeded its invocation time budget.",
    "Retry the same operation. The timed-out attempt's result was not returned and may not be saved; if SCAN_BUSY is returned, wait for the previous attempt to finish and retry.",
  );
}

/**
 * Per-call deadline. `timedOut` rejects once the budget is spent. `assertLive`
 * is called after every await so late work stops instead of continuing.
 * Disposing clears the timer on every settle path; it never releases the scan slot.
 */
class Invocation {
  private expired = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly timedOut: Promise<never>;

  constructor(ms: number) {
    let fail!: (err: AppError) => void;
    this.timedOut = new Promise<never>((_, reject) => (fail = reject));
    this.timer = setTimeout(() => {
      this.expired = true;
      fail(invocationTimeoutError());
    }, ms);
  }

  assertLive(): void {
    if (this.expired) throw invocationTimeoutError();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

export interface AccessibilityService {
  audit(url: string): Promise<ScanRun>;
  verify(url: string, baselineId: string): Promise<VerificationResult>;
  close(): Promise<void>;
}

/**
 * Effective-gate alignment. When enforcement raises the gate above what the
 * comparator reported, its completion claim is stale and MUST be replaced so
 * no stale pass remains (compare.ts owns the canonical claim strings; the
 * blocked/fail claim is inline there, mirrored verbatim below).
 */
function alignedCompletionClaim(effectiveGate: Gate): string {
  switch (effectiveGate) {
    case "pass":
      return PASS_COMPLETION_CLAIM;
    case "review_required":
      return REVIEW_REQUIRED_COMPLETION_CLAIM;
    case "fail":
      return "Blocked: the fresh scan of the same URL still reports selected-rule violations. Fix remaining findings and run verification again.";
    case "not_evaluated":
      return NOT_EVALUATED_COMPLETION_CLAIM;
  }
}

export function createService(options: ServiceOptions): AccessibilityService {
  const { engine, store, compareRuns, maxFindings, invocationTimeoutMs = DEFAULT_INVOCATION_TIMEOUT_MS } = options;
  if (!(invocationTimeoutMs > 0 && invocationTimeoutMs <= MAX_TIMER_MS)) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "invocationTimeoutMs must be a positive number of milliseconds no larger than 2147483647.",
      "Pass a valid value or omit it to use the 45-second default.",
    );
  }

  // One scan at a time: audits and verifications share the scan slot.
  // Reject rather than queue (SCAN_BUSY) — hosted demo, hard one-scan budget.
  let active = false;

  async function withScanSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active) {
      throw new AppError(
        "SCAN_BUSY",
        "A scan is already in progress; only one scan may run at a time.",
        "Wait for the active scan or verification to finish, then retry the same operation.",
      );
    }
    active = true;
    try {
      return await fn();
    } finally {
      active = false;
    }
  }

  /**
   * Runs one invocation under its deadline. The caller waits on whichever
   * settles first. `work` is never abandoned, so the scan slot it holds is
   * released only when it truly settles (inside withScanSlot's finally).
   */
  function invoke<T>(work: (inv: Invocation) => Promise<T>): Promise<T> {
    const inv = new Invocation(invocationTimeoutMs);
    const task = work(inv);
    task.catch(() => undefined); // a late rejection after timeout must not surface as unhandled
    return Promise.race([task, inv.timedOut]).finally(() => inv.dispose());
  }

  async function audit(url: string): Promise<ScanRun> {
    parseTargetUrl(url); // fail fast on structurally invalid input (before deadline or slot)
    return invoke((inv) =>
      withScanSlot(async () => {
        const stored: StoredScan = await engine.scan(url);
        inv.assertLive(); // timed out while scanning: do not persist a late result
        await store.save(stored);
        // A save underway at the deadline may still complete (orphan report);
        // the response is never returned past the deadline.
        inv.assertLive();
        // Compact response is always computed from the full stored record.
        return compactRunFromStored(stored, maxFindings);
      }),
    );
  }

  async function verify(url: string, baselineIdInput: string): Promise<VerificationResult> {
    parseTargetUrl(url);
    const baselineId = validateRunId(baselineIdInput);
    return invoke(async (inv) => {
      // Load FIRST, then validate comparable-conditions prerequisites before
      // spending a scan slot on the fresh scan.
      const baseline = await store.load(baselineId);
      inv.assertLive(); // a late baseline load must not lead to a scan
      if (canonicalTarget(baseline.run.requested_url) !== canonicalTarget(url)) {
        throw new AppError(
          "BASELINE_INCOMPATIBLE",
          "The baseline was captured for a different target URL.",
          `Run verify against the baseline's own URL: ${baseline.run.requested_url.split("#")[0]}`,
        );
      }
      return withScanSlot(async () => {
        const current = await engine.scan(url);
        inv.assertLive(); // timed out while scanning: never persist or compare a late scan
        await store.save(current);
        inv.assertLive();
        // Compact FIRST: enforcement must run against the compact gate derived
        // from the full findings — a comparator may report pass while the full
        // result still contains violations, which must stay a fail.
        const compactCurrentRun = compactRunFromStored(current, maxFindings);
        let verification: VerificationResult = compareRuns(baseline, current);
        const enforced = enforceRestrictiveGate(verification, compactCurrentRun.gate);
        const effectiveGate = enforced.gate;
        verification = {
          ...(effectiveGate !== verification.gate
            ? { ...verification, completion_claim: alignedCompletionClaim(effectiveGate) }
            : verification),
          gate: effectiveGate,
          baseline_id: baselineId,
          current_run: compactCurrentRun,
        };
        return verification;
      });
    });
  }

  return {
    audit,
    verify,
    close: () => engine.close(),
  };
}
