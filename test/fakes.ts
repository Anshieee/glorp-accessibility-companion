/**
 * Test-only fake ScanEngine + in-memory RunStore + fake comparator.
 * Clearly unit-level: no browser, no network. Named *_fake so it can never be
 * mistaken for real engine evidence.
 */
import { randomUUID } from "node:crypto";
import type {
  Finding,
  ReviewItem,
  ScanRun,
  StoredScan,
  ScanEngine,
  RunStore,
  VerificationResult,
} from "../src/contracts.js";
import { stableFindingKey } from "../src/contracts.js";
import { AppError } from "../src/errors.js";

export function finding(partial: Partial<Finding> & { rule_id: string; targets: string[] }): Finding {
  const id = stableFindingKey(partial.rule_id, partial.targets);
  return {
    id,
    rule_id: partial.rule_id,
    impact: partial.impact ?? "serious",
    description: partial.description ?? `description for ${partial.rule_id}`,
    help: partial.help ?? `help for ${partial.rule_id}`,
    help_url: partial.help_url ?? "https://example.invalid/help",
    wcag_tags: partial.wcag_tags ?? ["wcag2a"],
    targets: partial.targets,
    html: partial.html ?? "<div></div>",
    failure_summary: partial.failure_summary ?? "failure",
    guidance: partial.guidance ?? "fixed guidance",
    guidance_source: "rule_registry",
    requires_context: partial.requires_context ?? false,
  };
}

export function reviewItem(partial: Partial<ReviewItem> & { rule_id: string; targets: string[] }): ReviewItem {
  return {
    rule_id: partial.rule_id,
    targets: partial.targets,
    reason: partial.reason ?? "needs review",
    html: partial.html ?? null,
  };
}

export interface FakeScanSpec {
  findings: Finding[];
  reviewItems?: ReviewItem[];
  pageTitle?: string;
  url?: string;
  finalUrl?: string;
  gateOverride?: ScanRun["gate"];
  incompleteNodeCount?: number;
}

export function makeStored(spec: FakeScanSpec, when = new Date()): StoredScan {
  const fullFindings = spec.findings ?? [];
  const fullReview = spec.reviewItems ?? [];
  const gate: ScanRun["gate"] =
    spec.gateOverride ??
    (fullFindings.length > 0 ? "fail" : fullReview.length > 0 ? "review_required" : "pass");
  const run: ScanRun = {
    schema_version: "1.0",
    run_id: randomUUID(),
    execution: "completed",
    started_at: new Date(when.getTime() - 1000).toISOString(),
    completed_at: when.toISOString(),
    duration_ms: 12,
    requested_url: spec.url ?? "https://india.gov.in/page",
    final_url: spec.finalUrl ?? spec.url ?? "https://india.gov.in/page",
    page_title: spec.pageTitle ?? "Page",
    conditions: {
      viewport: { width: 1280, height: 720 },
      color_scheme: "light",
      browser_locale: "en-US",
      readiness_selector: null,
      scope: "full_page",
    },
    engine: {
      axe_version: "4.11.0",
      playwright_version: "1.56.0",
      rule_ids: ["color-contrast", "image-alt", "label", "select-name", "link-name", "button-name", "html-has-lang", "html-lang-valid"],
      ruleset_fingerprint: "fake-fingerprint",
    },
    coverage: {
      categories: ["Text contrast", "Image alternatives", "Form labels", "Link names", "Button names", "Document language"],
      evaluated_rule_ids: [],
      inapplicable_rule_ids: [],
      incomplete_rule_ids: [],
      current_rendered_state_only: true,
      frame_coverage: "main_document_only",
    },
    counts: {
      violation_rule_count: new Set(fullFindings.map((f) => f.rule_id)).size,
      violation_node_count: fullFindings.length,
      incomplete_node_count: spec.incompleteNodeCount ?? 0,
      returned_finding_count: fullFindings.length,
      omitted_finding_count: 0,
    },
    findings: fullFindings,
    review_items: fullReview,
    gate: fullFindings.length > 0 ? "fail" : gate,
    details_truncated: false,
    report_path: `runs/${randomUUID()}.json`,
    warnings: [],
    limitations: ["unit-test fake"],
  };
  // Fix report_path to actual (test realism is not needed beyond shape).
  run.report_path = "runs/placeholder.json";
  return {
    run,
    full_findings: fullFindings,
    full_review_items: fullReview,
    evidence: {},
  };
}

export class FakeEngine implements ScanEngine {
  lastUrl: string | undefined;
  scanCount = 0;
  closed = false;
  constructor(
    public readonly responses: Array<(url: string) => StoredScan | never> = [],
    public readonly latencyMs = 0,
  ) {}

  async scan(url: string): Promise<StoredScan> {
    this.lastUrl = url;
    this.scanCount += 1;
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    const responder = this.responses[Math.min(this.scanCount - 1, this.responses.length - 1)];
    if (typeof responder !== "function") throw new Error("fake engine misconfigured");
    return responder(url);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeEngineThrowing implements ScanEngine {
  constructor(readonly code: "TARGET_UNREACHABLE" | "SCAN_BUSY" = "TARGET_UNREACHABLE") {}
  async scan(_url: string): Promise<StoredScan> {
    throw new AppError(this.code, `engine fake: ${this.code}`, "retry later");
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class InMemoryStore implements RunStore {
  readonly saved = new Map<string, StoredScan>();
  constructor(readonly failNextSave = false) {}

  async save(record: StoredScan): Promise<void> {
    if (this.failNextSave) {
      throw new AppError("REPORT_WRITE_FAILED", "fake save failure", "retry", false);
    }
    if (this.saved.has(record.run.run_id)) {
      throw new AppError("REPORT_WRITE_FAILED", "fake: duplicate run id", "use a fresh audit", false);
    }
    this.saved.set(record.run.run_id, JSON.parse(JSON.stringify(record)) as StoredScan);
  }

  async load(id: string): Promise<StoredScan> {
    if (!this.saved.has(id)) throw AppError.notFound(id);
    return JSON.parse(JSON.stringify(this.saved.get(id))) as StoredScan;
  }
}

/** Fake comparator: honest pass-through signature used by the service. */
export function fakeCompareRuns(
  baseline: StoredScan,
  current: StoredScan,
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  const remaining: string[] = [];
  const newlyDetected: string[] = [];
  for (const currentFinding of current.full_findings) {
    const factor = baseline.full_findings.some(
      (b) => b.rule_id === currentFinding.rule_id && JSON.stringify(b.targets) === JSON.stringify(currentFinding.targets),
    );
    (factor ? remaining : newlyDetected).push(currentFinding.id);
  }
  const noLonger = baseline.full_findings
    .filter((b) => !current.full_findings.some((c) => c.rule_id === b.rule_id && JSON.stringify(c.targets) === JSON.stringify(b.targets)))
    .map((b) => b.id);
  return {
    schema_version: "1.0",
    baseline_id: baseline.run.run_id,
    current_run: current.run,
    comparison: {
      comparable: true,
      remaining_ids: remaining,
      newly_detected_ids: newlyDetected,
      no_longer_detected_ids: noLonger,
      uncertain_baseline_ids: [],
      notes: ["fake comparator notes"],
    },
    gate: current.run.gate,
    completion_claim: "fake completion claim",
    ...overrides,
  };
}
