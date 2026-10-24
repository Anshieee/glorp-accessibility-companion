/**
 * Accessibility Companion — frontend API client.
 *
 * PROPOSED contract (not frozen). See Accessibility_MCP_PRD.md and
 * HACKATHON_TEAM_HANDOFF.md section 5.2.
 *
 * - This frontend uses the same-origin API base by default; set
 *   VITE_API_BASE_URL to a public URL when the frontend is hosted elsewhere.
 *   Never put secrets/API keys in frontend env vars.
 * - All requests are aborted after 55s. The backend targets ~45s per scan.
 * - The server may respond with HTTP 4xx/5xx carrying an error body of shape:
 *     { execution: "failed", error: { code, message, recoverable, next_action } }
 */

export const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";

export const REQUEST_TIMEOUT_MS = 55_000;

export type Gate = "pass" | "fail" | "review_required" | "not_evaluated";
export type Impact = "minor" | "moderate" | "serious" | "critical" | null;

export interface Finding {
  id?: string;
  rule_id: string;
  impact: Impact;
  description: string;
  help: string;
  help_url?: string;
  wcag_tags?: string[];
  targets?: string[];
  html: string;
  failure_summary?: string | null;
  guidance: string;
  guidance_source?: string;
  requires_context?: boolean;
}

export interface ReviewItem {
  rule_id: string;
  targets?: string[];
  reason: string;
  html?: string | null;
}

export interface ScanRun {
  schema_version?: string;
  run_id: string;
  execution?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  requested_url: string;
  final_url?: string;
  page_title?: string;
  engine?: {
    axe_version?: string;
    playwright_version?: string;
    rule_ids?: string[];
    ruleset_fingerprint?: string;
  };
  coverage?: {
    categories?: string[];
    evaluated_rule_ids?: string[];
    inapplicable_rule_ids?: string[];
    incomplete_rule_ids?: string[];
    current_rendered_state_only?: boolean;
    frame_coverage?: string;
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
  report_path?: string;
  warnings?: string[];
  limitations?: string[];
}

export interface Comparison {
  comparable: boolean;
  remaining_ids?: string[];
  newly_detected_ids?: string[];
  no_longer_detected_ids?: string[];
  uncertain_baseline_ids?: string[];
  notes?: string[];
}

export interface VerificationResult {
  schema_version?: string;
  baseline_id: string;
  current_run: ScanRun;
  comparison: Comparison;
  gate: Gate;
  completion_claim: string;
}

export interface ApiErrorBody {
  execution: "failed";
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    next_action: string;
  };
}

export interface AppConfig {
  allowed_origins?: string[];
  allowed_hosts?: string[];
  public_base_url?: string;
  targets?: Array<{ label: string; url: string }>;
  rule_ids?: string[];
  limitations?: string[];
}

/** A normalized, UI-safe API error. */
export class ApiClientError extends Error {
  code: string;
  recoverable: boolean;
  next_action: string;
  httpStatus: number | null;

  constructor(
    code: string,
    message: string,
    opts: { recoverable?: boolean; next_action?: string; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.recoverable = opts.recoverable ?? false;
    this.next_action = opts.next_action ?? "";
    this.httpStatus = opts.httpStatus ?? null;
  }
}

function normalizeError(err: unknown): ApiClientError {
  if (err instanceof ApiClientError) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return new ApiClientError("REQUEST_TIMEOUT", "The request timed out after 55s. The backend may still be processing; please retry.", {
      recoverable: true,
      next_action: "Wait a moment and retry the same request.",
    });
  }
  if (err instanceof TypeError) {
    return new ApiClientError("NETWORK_ERROR", "Could not reach the API. Check that the backend service is running.", {
      recoverable: true,
      next_action: "Confirm the service is up, then retry.",
    });
  }
  return new ApiClientError("UNKNOWN", err instanceof Error ? err.message : "Unexpected error.", {
    recoverable: false,
    next_action: "Please retry.",
  });
}

async function parseErrorBody(res: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (body && typeof body === "object") {
    const e = (body as ApiErrorBody).error;
    if (e && typeof e.code === "string") {
      return new ApiClientError(e.code, e.message, {
        recoverable: e.recoverable,
        next_action: e.next_action,
        httpStatus: res.status,
      });
    }
  }
  return new ApiClientError("HTTP_ERROR", `Request failed with HTTP ${res.status}.`, {
    recoverable: res.status >= 500,
    next_action: res.status === 429 ? "Too many requests — wait and retry." : "Retry the request.",
    httpStatus: res.status,
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw await parseErrorBody(res);
    }
    return (await res.json()) as T;
  } catch (err) {
    throw normalizeError(err);
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  /** PROPOSED — GET /api/v1/config */
  config: () => request<AppConfig>("/api/v1/config", { method: "GET" }),

  /** PROPOSED — POST /api/v1/audits { url } => ScanRun */
  audit: (url: string) =>
    request<ScanRun>("/api/v1/audits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),

  /** PROPOSED — POST /api/v1/verifications { url, baseline_id } => VerificationResult */
  verify: (url: string, baseline_id: string) =>
    request<VerificationResult>("/api/v1/verifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, baseline_id }),
    }),
};

export function runApiUrl(runId: string): string {
  return `${BASE}/api/v1/runs/${encodeURIComponent(runId)}`;
}
