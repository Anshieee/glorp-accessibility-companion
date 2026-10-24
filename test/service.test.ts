import { describe, expect, it, vi } from "vitest";
import { createService } from "../src/service.js";
import { AppError } from "../src/errors.js";
import type { RunStore, ScanEngine, StoredScan } from "../src/contracts.js";
import {
  FakeEngine,
  FakeEngineThrowing,
  InMemoryStore,
  fakeCompareRuns,
  finding,
  makeStored,
  reviewItem,
} from "./fakes.js";

const MAX_FINDINGS = 100;

describe("createService.audit (fake engine)", () => {
  it("stores the full scan then returns a compact run derived from the full record", async () => {
    const stored = makeStored({
      url: "https://india.gov.in/page",
      findings: [
        finding({ rule_id: "label", targets: ["#name"] }),
        finding({ rule_id: "button-name", targets: ["#submit"] }),
      ],
    });
    const engine = new FakeEngine([() => stored]);
    const store = new InMemoryStore();
    const service = createService({ engine, store, compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    const run = await service.audit("https://india.gov.in/page");
    expect(run.run_id).toBe(stored.run.run_id);
    expect([...store.saved.keys()]).toContain(stored.run.run_id);
    // Compact response computed from the full record:
    expect(run.counts.violation_node_count).toBe(2);
    expect(run.gate).toBe("fail");
    expect(engine.lastUrl).toBe("https://india.gov.in/page");
  });

  it("omits findings beyond maxFindings but keeps counts honest and details_truncated", async () => {
    const many = Array.from({ length: 5 }, (_, i) => finding({ rule_id: "label", targets: [`#${i}`] }));
    const stored = makeStored({ findings: many });
    const service = createService({ engine: new FakeEngine([() => stored]), store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: 3 });
    const run = await service.audit("https://india.gov.in/page");
    expect(run.findings).toHaveLength(3);
    expect(run.counts.omitted_finding_count).toBe(2);
    expect(run.counts.violation_node_count).toBe(5);
    expect(run.details_truncated).toBe(true);
    expect(run.gate).toBe("fail");
  });

  it("propagates operational engine errors and never returns a fabricated success", async () => {
    const service = createService({
      engine: new FakeEngineThrowing("TARGET_UNREACHABLE"),
      store: new InMemoryStore(),
      compareRuns: fakeCompareRuns,
      maxFindings: MAX_FINDINGS,
    });
    await expect(service.audit("https://india.gov.in/page")).rejects.toMatchObject({ code: "TARGET_UNREACHABLE" });
  });

  it("fails the audit when persistence fails (no recoverable baseline)", async () => {
    const stored = makeStored({ findings: [] });
    const service = createService({
      engine: new FakeEngine([() => stored]),
      store: new InMemoryStore(true),
      compareRuns: fakeCompareRuns,
      maxFindings: MAX_FINDINGS,
    });
    await expect(service.audit("https://india.gov.in/page")).rejects.toMatchObject({ code: "REPORT_WRITE_FAILED" });
  });

  it("rejects a second concurrent scan with SCAN_BUSY and completes the first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new FakeEngine([
      async () => {
        await gate;
        return makeStored({ findings: [] });
      },
    ]);
    const service = createService({ engine: slow, store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    const first = service.audit("https://india.gov.in/one");
    await new Promise((r) => setTimeout(r, 5));
    await expect(service.audit("https://india.gov.in/two")).rejects.toMatchObject({ code: "SCAN_BUSY" });
    void release();
    await first; // first still completes
    expect(slow.scanCount).toBe(1);
  });

  it("serializes a scan after a completed one (no leaked lock)", async () => {
    const engine = new FakeEngine([
      () => makeStored({ url: "https://india.gov.in/one" }),
      () => makeStored({ url: "https://india.gov.in/two" }),
    ]);
    const service = createService({ engine, store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await service.audit("https://india.gov.in/one");
    await expect(service.audit("https://india.gov.in/two")).resolves.toBeTruthy();
    expect(engine.scanCount).toBe(2);
  });

  it("frees the scan slot when an audit fails", async () => {
    const failing = createService({ engine: new FakeEngineThrowing("TARGET_UNREACHABLE"), store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await expect(failing.audit("https://india.gov.in/x")).rejects.toMatchObject({ code: "TARGET_UNREACHABLE" });
    const next = makeStored({ findings: [] });
    const engine = new FakeEngine([() => next]);
    const ok = createService({ engine, store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await expect(ok.audit("https://india.gov.in/y")).resolves.toBeTruthy();
  });
});

describe("createService.verify (fake engine + fake comparator)", () => {
  it("loads the baseline first, scans fresh, stores the fresh run, and returns the comparison", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [finding({ rule_id: "label", targets: ["#name"] })] });
    const current = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const engine = new FakeEngine([() => current]);
    const service = createService({ engine, store, compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    const result = await service.verify("https://india.gov.in/page", baseline.run.run_id);
    expect(result.baseline_id).toBe(baseline.run.run_id);
    expect(result.comparison.no_longer_detected_ids).toContain(baseline.full_findings[0]?.id);
    expect(result.comparison.remaining_ids).toEqual([]);
    expect(result.gate).toBe("pass");
    expect(engine.scanCount).toBe(1);
    expect([...store.saved.keys()]).toContain(current.run.run_id); // fresh run persisted too
  });

  it("rejects a different URL with BASELINE_INCOMPATIBLE before scanning", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const engine = new FakeEngine([() => makeStored({})]);
    const service = createService({ engine, store, compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await expect(service.verify("https://other.example/page", baseline.run.run_id)).rejects.toMatchObject({ code: "BASELINE_INCOMPATIBLE" });
    expect(engine.scanCount).toBe(0);
  });

  it("treats fragment-only URL differences as the same target", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const engine = new FakeEngine([() => makeStored({ url: "https://india.gov.in/page" })]);
    const service = createService({ engine, store, compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await expect(service.verify("https://india.gov.in/page#frag", baseline.run.run_id)).resolves.toBeTruthy();
  });

  it("unknown baseline id → BASELINE_NOT_FOUND; invalid id → INVALID_ARGUMENT; path-like rejected", async () => {
    const engine = new FakeEngine([() => makeStored({})]);
    const service = createService({ engine, store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await expect(service.verify("https://india.gov.in/page", "22222222-2222-3333-4444-555555555555")).rejects.toMatchObject({ code: "BASELINE_NOT_FOUND" });
    await expect(service.verify("https://india.gov.in/page", "not-a-run-id")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(service.verify("https://india.gov.in/page", "../secrets.json")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(engine.scanCount).toBe(0);
  });

  it("expired baseline → REPORT_EXPIRED", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    // Simulate local record expiry via the real createLocalStore path covered in
    // store tests; here we assert the service never swallows the error type.
    const service = createService({
      engine: new FakeEngine([() => makeStored({})]),
      store: {
        save: async (r) => void r,
        load: async () => {
          throw AppError.expired("x");
        },
      },
      compareRuns: fakeCompareRuns,
      maxFindings: MAX_FINDINGS,
    });
    await expect(service.verify("https://india.gov.in/page", "22222222-2222-3333-4444-555555555555")).rejects.toMatchObject({ code: "REPORT_EXPIRED" });
  });

  it("comparator conditions conflict surfaces BASELINE_INCOMPATIBLE", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const strictComparator = () => {
      throw new AppError("BASELINE_INCOMPATIBLE", "conditions differ", "create a new baseline after the change");
    };
    const service = createService({
      engine: new FakeEngine([() => makeStored({ url: "https://india.gov.in/page" })]),
      store,
      compareRuns: strictComparator,
      maxFindings: MAX_FINDINGS,
    });
    await expect(service.verify("https://india.gov.in/page", baseline.run.run_id)).rejects.toMatchObject({ code: "BASELINE_INCOMPATIBLE" });
  });

  it("enforces that the verification gate is at least as restrictive as the current scan gate", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const current = makeStored({ url: "https://india.gov.in/page", findings: [finding({ rule_id: "link-name", targets: ["a.icon"] })] });
    const optimisticComparator = (b: Parameters<typeof fakeCompareRuns>[0], c: Parameters<typeof fakeCompareRuns>[1]) => ({
      ...fakeCompareRuns(b, c),
      gate: "pass" as const,
    });
    const service = createService({
      engine: new FakeEngine([() => current]),
      store,
      compareRuns: optimisticComparator,
      maxFindings: MAX_FINDINGS,
    });
    const result = await service.verify("https://india.gov.in/page", baseline.run.run_id);
    expect(result.gate).toBe("fail"); // upgraded from the buggy 'pass'
  });

  it("REGRESSION: compact gate (full findings) wins even when engine run gate and comparator both say pass", async () => {
    // The full stored result contains a violation, but run.gate (stale/wrong)
    // and the comparator both claim pass. Effective gate MUST be fail and the
    // completion claim MUST NOT remain the stale pass claim.
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const current = makeStored({
      url: "https://india.gov.in/page",
      findings: [finding({ rule_id: "button-name", targets: ["#btn"] })],
      gateOverride: "pass",
    });
    const passClaim = "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review.";
    const optimisticComparator = (b: Parameters<typeof fakeCompareRuns>[0], c: Parameters<typeof fakeCompareRuns>[1]) => ({
      ...fakeCompareRuns(b, c),
      gate: "pass" as const,
      completion_claim: passClaim,
    });
    const service = createService({
      engine: new FakeEngine([() => current]),
      store,
      compareRuns: optimisticComparator,
      maxFindings: MAX_FINDINGS,
    });
    const result = await service.verify("https://india.gov.in/page", baseline.run.run_id);
    expect(result.gate).toBe("fail");
    expect(result.completion_claim).not.toBe(passClaim);
    expect(result.completion_claim).toContain("violations");
    // current_run must be the compact view recomputed from full findings
    expect(result.current_run.gate).toBe("fail");
    expect(result.current_run.counts.violation_node_count).toBe(1);
  });

  it("review_required upgrades an optimistic comparator pass (claim aligned)", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const current = makeStored({
      url: "https://india.gov.in/page",
      findings: [],
      reviewItems: [reviewItem({ rule_id: "color-contrast", targets: ["#p"] })],
      gateOverride: "pass",
    });
    const passClaim = "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review.";
    const optimisticComparator = (b: Parameters<typeof fakeCompareRuns>[0], c: Parameters<typeof fakeCompareRuns>[1]) => ({
      ...fakeCompareRuns(b, c),
      gate: "pass" as const,
      completion_claim: passClaim,
    });
    const service = createService({
      engine: new FakeEngine([() => current]),
      store,
      compareRuns: optimisticComparator,
      maxFindings: MAX_FINDINGS,
    });
    const result = await service.verify("https://india.gov.in/page", baseline.run.run_id);
    expect(result.gate).toBe("review_required");
    expect(result.completion_claim).not.toBe(passClaim);
    expect(result.completion_claim.toLowerCase()).toContain("review");
  });

  it("aligned comparator outcome keeps the compare.ts completion claim untouched", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const current = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const claim = "compare-owned pass claim";
    const comparator = (b: Parameters<typeof fakeCompareRuns>[0], c: Parameters<typeof fakeCompareRuns>[1]) => ({
      ...fakeCompareRuns(b, c),
      gate: "pass" as const,
      completion_claim: claim,
    });
    const service = createService({
      engine: new FakeEngine([() => current]),
      store,
      compareRuns: comparator,
      maxFindings: MAX_FINDINGS,
    });
    const result = await service.verify("https://india.gov.in/page", baseline.run.run_id);
    expect(result.gate).toBe("pass");
    expect(result.completion_claim).toBe(claim); // aligned: no override
  });

  it("scan slot is released after verify conclusions (success or failure)", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [finding({ rule_id: "label", targets: ["#a"] })] });
    const store = new InMemoryStore();
    await store.save(baseline);
    const current = makeStored({ url: "https://india.gov.in/page", findings: [finding({ rule_id: "label", targets: ["#a"] })] });
    const engine = new FakeEngine([() => current, () => makeStored({ url: "https://india.gov.in/page", findings: [] })]);
    const service = createService({ engine, store, compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    const v1 = await service.verify("https://india.gov.in/page", baseline.run.run_id);
    expect(v1.comparison.remaining_ids.length).toBe(1);
    const secondBaseline = current;
    const v2 = await service.verify("https://india.gov.in/page", secondBaseline.run.run_id);
    expect(v2.comparison.remaining_ids).toEqual([]);
  });

  it("fails the verification when the fresh run cannot be persisted", async () => {
    const baseline = makeStored({ url: "https://india.gov.in/page", findings: [] });
    const service = createService({
      engine: new FakeEngine([() => makeStored({ url: "https://india.gov.in/page" })]),
      store: {
        save: async () => {
          throw new AppError("REPORT_WRITE_FAILED", "persist failed", "retry", false);
        },
        load: async () => baseline,
      },
      compareRuns: fakeCompareRuns,
      maxFindings: MAX_FINDINGS,
    });
    await expect(service.verify("https://india.gov.in/page", baseline.run.run_id)).rejects.toMatchObject({ code: "REPORT_WRITE_FAILED" });
  });

  it("close() closes the engine", async () => {
    const engine = new FakeEngine();
    const service = createService({ engine, store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
    await service.close();
    expect(engine.closed).toBe(true);
  });
});

/** Test-only deferred engine: scan() stays pending until the test finishes or fails it. */
class DeferredEngineFake implements ScanEngine {
  scanCount = 0;
  closed = false;
  private readonly waiters: Array<{ resolve: (s: StoredScan) => void; reject: (e: unknown) => void }> = [];

  scan(_url: string): Promise<StoredScan> {
    this.scanCount += 1;
    return new Promise<StoredScan>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  finish(stored: StoredScan): void {
    this.waiters.shift()?.resolve(stored);
  }

  fail(err: unknown): void {
    this.waiters.shift()?.reject(err);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Test-only store wrapper: load/save wait on optional gates before delegating to InMemoryStore. */
class GatedStoreFake implements RunStore {
  constructor(
    readonly inner: InMemoryStore,
    private readonly gates: { load?: Promise<void>; save?: Promise<void> } = {},
  ) {}

  async save(record: StoredScan): Promise<void> {
    await this.gates.save;
    return this.inner.save(record);
  }

  async load(id: string): Promise<StoredScan> {
    await this.gates.load;
    return this.inner.load(id);
  }
}

describe("createService invocation deadline (fake engine + fake store only)", () => {
  const URL = "https://india.gov.in/page";
  const DEADLINE_MS = 50;
  /** Real await so released work can settle before assertions. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const deps = () => ({ compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS, invocationTimeoutMs: DEADLINE_MS });

  it("audit returns SCAN_TIMEOUT at the deadline while the scan is still pending; engine is not closed", async () => {
    const engine = new DeferredEngineFake();
    const store = new InMemoryStore();
    const service = createService({ engine, store, ...deps() });
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_TIMEOUT", recoverable: true });
    expect(engine.closed).toBe(false);
    expect(store.saved.size).toBe(0);
  });

  it("verify: timeout during baseline load → a late load never launches the engine", async () => {
    const inner = new InMemoryStore();
    const baseline = makeStored({ url: URL, findings: [] });
    await inner.save(baseline);
    let openLoad!: () => void;
    const store = new GatedStoreFake(inner, { load: new Promise<void>((resolve) => (openLoad = resolve)) });
    const engine = new FakeEngine([() => makeStored({ url: URL, findings: [] })]);
    const service = createService({ engine, store, ...deps() });
    await expect(service.verify(URL, baseline.run.run_id)).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
    openLoad();
    await settle();
    expect(engine.scanCount).toBe(0);
    expect(inner.saved.size).toBe(1); // only the baseline; no fresh run persisted
  });

  it("verify: timeout during scan → a scan finishing after the deadline is never persisted or returned", async () => {
    const store = new InMemoryStore();
    const baseline = makeStored({ url: URL, findings: [] });
    await store.save(baseline);
    const current = makeStored({ url: URL, findings: [] });
    const engine = new DeferredEngineFake();
    const service = createService({ engine, store, ...deps() });
    const outcome = service.verify(URL, baseline.run.run_id);
    await expect(outcome).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
    engine.finish(current);
    await settle();
    expect(store.saved.has(current.run.run_id)).toBe(false);
    expect(store.saved.size).toBe(1);
  });

  it("audit: timeout during save → SCAN_TIMEOUT (not a report); slot held until save settles, then reusable", async () => {
    const inner = new InMemoryStore();
    let openSave!: () => void;
    const store = new GatedStoreFake(inner, { save: new Promise<void>((resolve) => (openSave = resolve)) });
    const engine = new FakeEngine([
      () => makeStored({ url: URL, findings: [] }),
      () => makeStored({ url: URL, findings: [] }),
    ]);
    const service = createService({ engine, store, ...deps() });
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
    // Save is still underway, so the slot is still held.
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_BUSY" });
    expect(engine.scanCount).toBe(1);
    openSave();
    await settle();
    // Documented caveat: the save completed after the deadline, so that orphan report exists.
    expect(inner.saved.size).toBe(1);
    await expect(service.audit(URL)).resolves.toMatchObject({ gate: "pass" });
    expect(engine.scanCount).toBe(2);
  });

  it("busy during cleanup: a timed-out scan keeps the slot until it settles, then the slot is reusable", async () => {
    const engine = new DeferredEngineFake();
    const store = new InMemoryStore();
    const service = createService({ engine, store, ...deps() });
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_BUSY" });
    expect(engine.scanCount).toBe(1);
    engine.finish(makeStored({ url: URL, findings: [] }));
    await settle();
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_TIMEOUT" }); // new scan, pending again
    expect(engine.scanCount).toBe(2);
  });

  it("a late scan failure after the deadline is swallowed (no unhandled rejection) and the slot frees", async () => {
    const engine = new DeferredEngineFake();
    const service = createService({ engine, store: new InMemoryStore(), ...deps() });
    await expect(service.audit(URL)).rejects.toMatchObject({ code: "SCAN_TIMEOUT" });
    engine.fail(new AppError("TARGET_UNREACHABLE", "late failure", "retry"));
    await settle();
    const next = new FakeEngine([() => makeStored({ url: URL, findings: [] })]);
    const ok = createService({ engine: next, store: new InMemoryStore(), ...deps() });
    await expect(ok.audit(URL)).resolves.toBeTruthy();
  });

  it("fast success and fast engine errors are unaffected by the deadline", async () => {
    const ok = createService({
      engine: new FakeEngine([() => makeStored({ url: URL, findings: [] })]),
      store: new InMemoryStore(),
      ...deps(),
    });
    await expect(ok.audit(URL)).resolves.toMatchObject({ gate: "pass" });
    const failing = createService({ engine: new FakeEngineThrowing("TARGET_UNREACHABLE"), store: new InMemoryStore(), ...deps() });
    await expect(failing.audit(URL)).rejects.toMatchObject({ code: "TARGET_UNREACHABLE" });
  });

  it("defaults the invocation deadline to 45s (not before 45000ms, timed out at 45000ms)", async () => {
    vi.useFakeTimers();
    try {
      const service = createService({ engine: new DeferredEngineFake(), store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS });
      let outcome: unknown = "pending";
      const call = service.audit(URL).then(
        () => {
          outcome = "resolved";
        },
        (err: unknown) => {
          outcome = err;
        },
      );
      await vi.advanceTimersByTimeAsync(44_999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(outcome).toMatchObject({ code: "SCAN_TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an invalid invocationTimeoutMs with CONFIGURATION_ERROR", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      let caught: unknown;
      try {
        createService({ engine: new FakeEngine(), store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: MAX_FINDINGS, invocationTimeoutMs: bad });
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code: "CONFIGURATION_ERROR" });
    }
  });
});
