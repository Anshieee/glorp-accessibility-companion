/**
 * Shared contracts for Accessibility Companion (hosted demo).
 * Single owner of the shared data interface: this file. Engine worker
 * (scanner/rules/normalize/compare), HTTP API and MCP tooling all import
 * from here. Pure types + small pure validation/comparison helpers only.
 */
import { AppError } from "./errors.js";

export const SCHEMA_VERSION = "1.0" as const;

export type Gate = "pass" | "fail" | "review_required" | "not_evaluated";

export type Impact = "minor" | "moderate" | "serious" | "critical" | null;

export interface Finding {
  /** Stable instance id (rule + target path). One finding per rule/node instance. */
  id: string;
  rule_id: string;
  impact: Impact;
  description: string;
  help: string;
  help_url: string;
  wcag_tags: string[];
  /** Preserved multi-part engine target path; parts are not standalone CSS selectors. */
  targets: string[];
  /** Engine node HTML snippet; untrusted application content, render as text only. */
  html: string;
  failure_summary: string | null;
  /** Fixed deterministic rule guidance — NOT a host-model suggestion or verified patch. */
  guidance: string;
  guidance_source: "rule_registry";
  requires_context: boolean;
}

export interface ReviewItem {
  rule_id: string;
  targets: string[];
  reason: string;
  html: string | null;
}

export interface ScanConditions {
  viewport: { width: number; height: number };
  color_scheme: "light";
  browser_locale: string;
  readiness_selector: string | null;
  scope: "full_page";
}

export interface ScanEngineInfo {
  axe_version: string;
  playwright_version: string;
  rule_ids: string[];
  ruleset_fingerprint: string;
}

export interface ScanCoverage {
  categories: string[];
  evaluated_rule_ids: string[];
  inapplicable_rule_ids: string[];
  incomplete_rule_ids: string[];
  current_rendered_state_only: true;
  frame_coverage: "main_document_only";
}

export interface ScanCounts {
  violation_rule_count: number;
  violation_node_count: number;
  incomplete_node_count: number;
  returned_finding_count: number;
  omitted_finding_count: number;
}

/**
 * Compact, externally visible scan result. `findings` is the bounded view
 * (details_truncated + omitted_finding_count when longer); full findings live
 * only inside StoredScan.
 */
export interface ScanRun {
  schema_version: "1.0";
  run_id: string;
  execution: "completed";
  started_at: string;
  completed_at: string;
  duration_ms: number;
  requested_url: string;
  final_url: string;
  page_title: string;
  conditions: ScanConditions;
  engine: ScanEngineInfo;
  coverage: ScanCoverage;
  counts: ScanCounts;
  findings: Finding[];
  review_items: ReviewItem[];
  gate: Gate;
  details_truncated: boolean;
  /** Opaque relative reference, e.g. "runs/<id>.json". Never a bucket URL or absolute path. */
  report_path: string;
  warnings: string[];
  limitations: string[];
}

export type EvidenceStatus = "pass" | "fail" | "incomplete" | "missing";

/**
 * Full persisted record. `run.findings` may be compact; `full_findings` /
 * `full_review_items` always contain everything. `evidence` is keyed by the
 * stable finding id over rule + target (stableFindingKey) so the comparator
 * can match unchanged elements across runs and record pass/fail/incomplete/
 * missing per element.
 */
export interface StoredScan {
  run: ScanRun;
  full_findings: Finding[];
  full_review_items: ReviewItem[];
  evidence: Record<string, EvidenceStatus>;
}

/**
 * Result of verify_fixes. compare.ts (engine worker) implements
 * compareRuns(baseline, current) => VerificationResult.
 * The verification gate must be at least as restrictive as current_run.gate
 * (the service layer defensively enforces this; see enforceRestrictiveGate).
 */
export interface VerificationResult {
  schema_version: "1.0";
  baseline_id: string;
  current_run: ScanRun;
  comparison: {
    comparable: true;
    remaining_ids: string[];
    newly_detected_ids: string[];
    no_longer_detected_ids: string[];
    uncertain_baseline_ids: string[];
    notes: string[];
  };
  gate: Gate;
  completion_claim: string;
}

/** Engine interface implemented by scanner.ts (engine worker). */
export interface ScanEngine {
  scan(url: string): Promise<StoredScan>;
  close(): Promise<void>;
}

/** Persistence interface implemented by store.ts. */
export interface RunStore {
  save(record: StoredScan): Promise<void>;
  load(id: string): Promise<StoredScan>;
}

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run IDs are UUIDs (randomUUID). Anything else, incl. path-like strings, is rejected. */
export function isValidRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_RE.test(value);
}

export function validateRunId(input: unknown): string {
  if (!isValidRunId(input)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "baseline_id must be a run identifier exactly as returned by a previous audit.",
      "Use the run_id from a prior successful audit response; it is a UUID with no paths or separators.",
    );
  }
  return input;
}

/** Stable finding/evidence key: rule id + normalized target path. */
export function stableFindingKey(ruleId: string, targets: readonly string[]): string {
  return `${ruleId}::${targets.join("|")}`;
}

export const EVIDENCE_STATUSES: readonly EvidenceStatus[] = ["pass", "fail", "incomplete", "missing"];

export function isEvidenceStatus(v: unknown): v is EvidenceStatus {
  return v === "pass" || v === "fail" || v === "incomplete" || v === "missing";
}

// ---------------------------------------------------------------------------
// Target URL validation (structural). Host/origin allowlist + SSRF policy are
// enforced by the engine (src/network.ts); this only rejects malformed and
// structurally unsafe URLs early.
// ---------------------------------------------------------------------------

export function parseTargetUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AppError("INVALID_ARGUMENT", "url is required and must be a string.", "Provide an absolute http(s) URL.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError("INVALID_ARGUMENT", "url must be an absolute URL.", "Provide an absolute http(s) URL, e.g. https://example.gov.in/page");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("TARGET_NOT_ALLOWED", "Only http(s) URLs are supported.", "Use an http or https URL on a permitted host.");
  }
  if (url.username !== "" || url.password !== "" || raw.includes("@")) {
    throw new AppError("TARGET_NOT_ALLOWED", "URLs with embedded credentials are not allowed.", "Remove credentials from the URL.");
  }
  return url;
}

/** Canonical form used for baseline comparability: fragments stripped, query preserved. */
export function canonicalTarget(raw: string): string {
  const url = parseTargetUrl(raw);
  url.hash = "";
  return url.toString();
}

// ---------------------------------------------------------------------------
// Strict request payload parsing (used by both HTTP API and MCP tools).
// ---------------------------------------------------------------------------

export function parseAuditPayload(input: unknown): { url: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_ARGUMENT", "Request body must be a JSON object.", 'Send { "url": "https://..." }.');
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "url") {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Body must contain exactly the field: url (no extra fields).",
      'Send only { "url": "https://..." } with no extra fields.',
    );
  }
  parseTargetUrl(obj.url); // structural validation (scheme, credentials, malformed)
  return { url: (obj.url as string).trim() };
}

export function parseVerificationPayload(input: unknown): { url: string; baseline_id: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("INVALID_ARGUMENT", "Request body must be a JSON object.", 'Send { "url": "https://...", "baseline_id": "..." }.');
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 2 || keys[0] !== "baseline_id" || keys[1] !== "url") {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Body must contain exactly the fields: url and baseline_id (no extra fields).",
      'Send only { "url": "https://...", "baseline_id": "..." } with no extra fields.',
    );
  }
  parseTargetUrl(obj.url);
  validateRunId(obj.baseline_id);
  return { url: (obj.url as string).trim(), baseline_id: obj.baseline_id as string };
}

// ---------------------------------------------------------------------------
// Full-record validation (storage boundary) and compact response computation.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

const GATES: Gate[] = ["pass", "fail", "review_required", "not_evaluated"];
const IMPACTS: NonNullable<Impact>[] = ["minor", "moderate", "serious", "critical"];

function validateFinding(v: unknown): Finding | null {
  if (!isRecord(v)) return null;
  if (!isStr(v.id) || !isStr(v.rule_id) || !isStr(v.description) || !isStr(v.help) || !isStr(v.help_url)) return null;
  if (v.impact !== null && !IMPACTS.includes(v.impact as never)) return null;
  if (!Array.isArray(v.wcag_tags) || !v.wcag_tags.every(isStr)) return null;
  if (!Array.isArray(v.targets) || v.targets.length === 0 || !v.targets.every(isStr)) return null;
  if (typeof v.html !== "string") return null;
  if (v.failure_summary !== null && typeof v.failure_summary !== "string") return null;
  if (!isStr(v.guidance) || v.guidance_source !== "rule_registry" || typeof v.requires_context !== "boolean") return null;
  return v as unknown as Finding;
}

function validateReviewItem(v: unknown): ReviewItem | null {
  if (!isRecord(v)) return null;
  if (!isStr(v.rule_id) || !isStr(v.reason)) return null;
  // Rule-level incomplete items may carry no node evidence (targets: []).
  // Findings must still have a non-empty targets path (see validateFinding).
  if (!Array.isArray(v.targets) || !v.targets.every(isStr)) return null;
  if (v.html !== null && typeof v.html !== "string") return null;
  return v as unknown as ReviewItem;
}

/**
 * Structural guard used by the store before persisting/returning a record.
 * Returns null when the record does not conform; never throws.
 */
export function validateStoredScan(value: unknown): StoredScan | null {
  if (!isRecord(value)) return null;
  // Top-level schema_version is optional for forward compatibility; run carries it.
  if (value.schema_version !== undefined && value.schema_version !== SCHEMA_VERSION) return null;
  const run = value.run;
  if (!isRecord(run)) return null;
  if (run.schema_version !== SCHEMA_VERSION) return null;
  if (!isValidRunId(run.run_id)) return null;
  if (run.execution !== "completed") return null;
  for (const key of ["started_at", "completed_at", "requested_url", "final_url", "page_title", "report_path"] as const) {
    if (typeof run[key] !== "string") return null;
  }
  if (typeof run.duration_ms !== "number" || !Number.isFinite(run.duration_ms)) return null;
  if (!isRecord(run.conditions)) return null;
  const c = run.conditions as Record<string, unknown>;
  const vp = c.viewport;
  if (!isRecord(vp) || typeof vp.width !== "number" || typeof vp.height !== "number") return null;
  if (c.color_scheme !== "light" || !isStr(c.browser_locale) || c.scope !== "full_page") return null;
  if (c.readiness_selector !== null && typeof c.readiness_selector !== "string") return null;
  if (!isRecord(run.engine)) return null;
  const e = run.engine as Record<string, unknown>;
  if (!isStr(e.axe_version) || !isStr(e.playwright_version) || !isStr(e.ruleset_fingerprint)) return null;
  if (!Array.isArray(e.rule_ids) || !e.rule_ids.every(isStr)) return null;
  if (!isRecord(run.coverage) || !isRecord(run.counts)) return null;
  const counts = run.counts as Record<string, unknown>;
  for (const key of Object.keys(counts)) {
    if (typeof counts[key] !== "number" || !Number.isFinite(counts[key])) return null;
  }
  if (!Array.isArray(run.findings) || !Array.isArray(run.review_items)) return null;
  if (!run.findings.every((f) => validateFinding(f) !== null)) return null;
  if (!run.review_items.every((r) => validateReviewItem(r) !== null)) return null;
  if (typeof run.gate !== "string" || !GATES.includes(run.gate as Gate)) return null;
  if (typeof run.details_truncated !== "boolean" || typeof run.report_path !== "string") return null;
  if (!Array.isArray(run.warnings) || !run.warnings.every(isStr)) return null;
  if (!Array.isArray(run.limitations) || !run.limitations.every(isStr)) return null;

  const evidence = value.evidence;
  if (!isRecord(evidence)) return null;
  for (const [k, v] of Object.entries(evidence)) {
    if (!isStr(k) || !isEvidenceStatus(v)) return null;
  }
  const full = value.full_findings;
  const fullReview = value.full_review_items;
  if (!Array.isArray(full) || !Array.isArray(fullReview)) return null;
  if (!full.every((f) => validateFinding(f) !== null)) return null;
  if (!fullReview.every((r) => validateReviewItem(r) !== null)) return null;
  return value as unknown as StoredScan;
}

/** Restrictiveness rank for gates; higher = more restrictive. not_evaluated is treated as most restrictive. */
export function gateRank(gate: Gate): number {
  switch (gate) {
    case "pass":
      return 0;
    case "review_required":
      return 1;
    case "fail":
      return 2;
    case "not_evaluated":
      return 3;
  }
}

/**
 * Most restrictive of the given gates (highest gateRank). Evidence sources are
 * merged with this, never overwritten: a stored engine gate can be made
 * stricter by detail arrays, but nothing can make it less strict.
 */
export function mostRestrictiveGate(...gates: Gate[]): Gate {
  return gates.reduce<Gate>((worst, g) => (gateRank(g) > gateRank(worst) ? g : worst), "pass");
}

export function enforceRestrictiveGate(verification: VerificationResult, currentGate: Gate): VerificationResult {
  if (currentGate === "not_evaluated" || gateRank(verification.gate) < gateRank(currentGate)) {
    return { ...verification, gate: currentGate };
  }
  return verification;
}

/**
 * Compact externally visible run computed from the FULL stored record.
 * Counts, gate and details_truncated are recomputed from full findings/review
 * items so truncation can never hide a failure behind a result cap. The gate is
 * the most restrictive of the full-array floor and the stored engine gate, so
 * it can only become stricter, never a pass, than what the engine recorded.
 */
export function compactRunFromStored(stored: StoredScan, maxFindings: number): ScanRun {
  const full = stored.full_findings;
  const fullReview = stored.full_review_items;
  // Invalid caps (negative, NaN, non-number) show nothing extra; counts and the gate still
  // come from the full record, so an invalid cap can never hide a result.
  const cap = typeof maxFindings === "number" && maxFindings >= 0 ? Math.floor(maxFindings) : 0;
  const findings = full.slice(0, cap);
  const reviewItems = fullReview.slice(0, cap);
  const omitted = full.length - findings.length;
  const reviewOmitted = fullReview.length - reviewItems.length;
  const truncated = omitted > 0 || reviewOmitted > 0;

  // Floor derived from the FULL arrays and the engine's incomplete count. Merged
  // with the stored gate by restrictiveness: the stored gate (e.g. review_required
  // from fonts/duplicates/blocked assets, or not_evaluated) is never downgraded,
  // and an unknown stored value is treated as not_evaluated, never pass.
  const derivedGate: Gate =
    full.length > 0 ? "fail" : stored.run.counts.incomplete_node_count > 0 || fullReview.length > 0 ? "review_required" : "pass";
  const storedGate: Gate = GATES.includes(stored.run.gate) ? stored.run.gate : "not_evaluated";
  const gate: Gate = mostRestrictiveGate(derivedGate, storedGate);

  const warnings = stored.run.warnings.slice();
  if (omitted > 0) {
    warnings.push(`${omitted} additional finding(s) omitted from the returned details; full findings are stored in the run report.`);
  }
  if (reviewOmitted > 0) {
    warnings.push(`${reviewOmitted} additional review item(s) omitted from the returned details; full review items are stored in the run report.`);
  }

  return {
    ...stored.run,
    counts: {
      violation_rule_count: new Set(full.map((f) => f.rule_id)).size,
      violation_node_count: full.length,
      incomplete_node_count: stored.run.counts.incomplete_node_count,
      returned_finding_count: findings.length,
      omitted_finding_count: omitted,
    },
    findings,
    review_items: reviewItems,
    gate,
    details_truncated: truncated,
    warnings,
  };
}
