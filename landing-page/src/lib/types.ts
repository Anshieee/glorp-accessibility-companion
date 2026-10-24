export type Gate = 'pass' | 'fail' | 'review_required' | 'not_evaluated';
export type Impact = 'minor' | 'moderate' | 'serious' | 'critical' | null;

export interface Finding {
  id: string;
  rule_id: string;
  impact: Impact;
  description: string;
  help: string;
  help_url: string;
  wcag_tags: string[];
  targets: string[];
  html: string;
  failure_summary: string | null;
  guidance: string;
  guidance_source: 'rule_registry';
  requires_context: boolean;
  // Optional server-provided extras. The hosted demo engine does NOT provide
  // these; the UI renders them ONLY when factually present in the response and
  // never fabricates them. Absence is normal and must not be treated as an error.
  ai_insight?: string;
  suggested_code_diff?: {
    before: string;
    after: string;
  };
}

export interface ReviewItem {
  rule_id: string;
  targets: string[];
  reason: string;
  html: string | null;
}

export interface ScanRun {
  schema_version: '1.0';
  run_id: string;
  execution: 'completed';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  requested_url: string;
  final_url: string;
  page_title: string;
  conditions: {
    viewport: { width: number; height: number };
    color_scheme: 'light';
    browser_locale: string;
    readiness_selector: string | null;
    scope: 'full_page';
  };
  engine: {
    axe_version: string;
    playwright_version: string;
    rule_ids: string[];
    ruleset_fingerprint: string;
  };
  coverage: {
    categories: string[];
    evaluated_rule_ids: string[];
    inapplicable_rule_ids: string[];
    incomplete_rule_ids: string[];
    current_rendered_state_only: true;
    frame_coverage: 'main_document_only';
  };
  counts: {
    violation_rule_count: number;
    violation_node_count: number;
    incomplete_node_count: number;
    returned_finding_count: number;
    omitted_finding_count: number;
  };
  findings: Finding[];
  review_items: ReviewItem[];
  gate: Gate;
  details_truncated: boolean;
  report_path: string;
  warnings: string[];
  limitations: string[];
}

export type DeltaStatus = 'remaining' | 'newly_detected' | 'no_longer_detected' | 'uncertain';

export interface VerificationComparison {
  comparable: true;
  remaining_ids: string[];
  newly_detected_ids: string[];
  no_longer_detected_ids: string[];
  uncertain_baseline_ids: string[];
  notes: string[];
}

export interface VerificationResult {
  schema_version: '1.0';
  baseline_id: string;
  current_run: ScanRun;
  comparison: VerificationComparison;
  gate: Gate;
  completion_claim: string;
}

export interface ScanError {
  execution: 'failed';
  error: {
    code:
      | 'INVALID_ARGUMENT'
      | 'TARGET_NOT_ALLOWED'
      | 'TARGET_UNREACHABLE'
      | 'TARGET_NOT_READY'
      | 'BROWSER_UNAVAILABLE'
      | 'SCAN_TIMEOUT'
      | 'SCAN_BUSY';
    message: string;
    recoverable: boolean;
    next_action: string;
  };
}
