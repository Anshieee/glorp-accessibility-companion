/**
 * Real API client for the Accessibility Companion hosted demo.
 *
 * Same-origin by default. Optional override via NEXT_PUBLIC_GLORP_API_URL
 * (public base URL only, never secrets).
 *
 * Routes (authoritative, see root src/server.ts):
 *   POST /api/v1/audits        { url }
 *   POST /api/v1/verifications { url, baseline_id }
 *   GET  /api/v1/config
 *   GET  /api/v1/runs/:run_id
 *
 * There is intentionally NO mock fallback, NO simulated latency, and NO
 * fabricated run IDs. Any backend failure surfaces as a typed ApiError with
 * { code, message, next_action } exactly as the server returns them.
 */
import type { ScanRun, VerificationResult, Gate, Finding, ReviewItem } from './types';

const API_BASE_URL = (process.env.NEXT_PUBLIC_GLORP_API_URL ?? '').replace(/\/$/, '');

const REQUEST_TIMEOUT_MS = 55_000;

export interface ApiErrorShape {
  execution: 'failed';
  error: {
    code: string;
    message: string;
    next_action: string;
    recoverable?: boolean;
  };
}

export class ApiError extends Error {
  code: string;
  nextAction: string;
  recoverable: boolean;

  constructor(code: string, message: string, nextAction: string, recoverable = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.nextAction = nextAction;
    this.recoverable = recoverable;
  }
}

export function parseApiError(body: unknown, fallbackCode: string, status: number): ApiError {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const err = (body as { error?: unknown }).error;
    if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
      const e = err as Record<string, unknown>;
      if (typeof e.code === 'string' && typeof e.message === 'string') {
        return new ApiError(
          e.code,
          e.message,
          typeof e.next_action === 'string' ? e.next_action : 'See GET /api/v1/config for allowed targets.',
          typeof e.recoverable === 'boolean' ? e.recoverable : false,
        );
      }
    }
  }
  return new ApiError(
    fallbackCode,
    `Request failed with HTTP ${status}.`,
    'Retry the request; if it persists, check GET /api/v1/config for allowed targets.',
    false,
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw parseApiError(body, 'SCAN_FAILED', response.status);
    }
    return body as T;
  } catch (err: unknown) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(
        'SCAN_TIMEOUT',
        'The scan request timed out after 55 seconds.',
        'Retry once; if the target is slow, try again later.',
        true,
      );
    }
    throw new ApiError(
      'SCAN_FAILED',
      err instanceof Error ? err.message : 'Network request failed.',
      'Check your connection and confirm the demo backend is reachable, then retry.',
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonGet<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { signal: controller.signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw parseApiError(body, 'SCAN_FAILED', response.status);
    }
    return body as T;
  } catch (err: unknown) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('SCAN_TIMEOUT', 'The config request timed out.', 'Retry once.', true);
    }
    throw new ApiError(
      'SCAN_FAILED',
      err instanceof Error ? err.message : 'Network request failed.',
      'Check your connection and confirm the demo backend is reachable, then retry.',
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client-side URL normalization mirroring the server contract:
 * - required, absolute http(s) only
 * - refuse embedded credentials (user:pass@)
 * - strip fragment (#...), preserve query (?...)
 * - missing scheme defaults to https://
 */
export function normalizeTargetUrl(input: string): { valid: boolean; url: string; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, url: '', error: 'Please enter a website URL.' };
  }
  if (trimmed.includes('@')) {
    return { valid: false, url: '', error: 'URLs with embedded credentials are not allowed. Remove user:password@ from the URL.' };
  }
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, url: '', error: 'Please enter a valid absolute URL (e.g. https://example.com/page).' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, url: '', error: 'Only http and https URLs are supported.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { valid: false, url: '', error: 'URLs with embedded credentials are not allowed.' };
  }
  if (!parsed.hostname) {
    return { valid: false, url: '', error: 'Please enter a valid absolute URL with a hostname.' };
  }
  parsed.hash = '';
  return { valid: true, url: parsed.toString() };
}

// ---------------------------------------------------------------------------
// Response validation: never render guessed findings. Reject malformed runs.
// ---------------------------------------------------------------------------

const VALID_GATES: Gate[] = ['pass', 'fail', 'review_required', 'not_evaluated'];
const VALID_IMPACTS = ['minor', 'moderate', 'serious', 'critical'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateFinding(v: unknown): v is Finding {
  if (!isRecord(v)) return false;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.rule_id !== 'string' || v.rule_id.length === 0) return false;
  if (v.impact !== null && !VALID_IMPACTS.includes(v.impact as string)) return false;
  if (typeof v.description !== 'string' || typeof v.help !== 'string' || typeof v.help_url !== 'string') return false;
  if (!Array.isArray(v.wcag_tags)) return false;
  if (!Array.isArray(v.targets) || v.targets.length === 0) return false;
  if (typeof v.html !== 'string') return false;
  if (v.failure_summary !== null && typeof v.failure_summary !== 'string') return false;
  if (typeof v.guidance !== 'string' || v.guidance_source !== 'rule_registry') return false;
  if (typeof v.requires_context !== 'boolean') return false;
  // ai_insight / suggested_code_diff are server-optional and never fabricated here.
  return true;
}

function validateReviewItem(v: unknown): v is ReviewItem {
  if (!isRecord(v)) return false;
  if (typeof v.rule_id !== 'string' || typeof v.reason !== 'string') return false;
  if (!Array.isArray(v.targets)) return false;
  if (v.html !== null && typeof v.html !== 'string') return false;
  return true;
}

export function validateScanRun(value: unknown): ScanRun {
  if (!isRecord(value)) throw new ApiError('SCAN_FAILED', 'Backend returned a malformed audit response.', 'Retry the audit; if it persists, contact the demo operators.');
  const v = value as Record<string, unknown>;
  if (v.schema_version !== '1.0') throw new ApiError('SCAN_FAILED', 'Backend returned an unexpected schema version.', 'Retry the audit.');
  if (v.execution !== 'completed') throw new ApiError('SCAN_FAILED', 'Backend returned a non-completed audit execution.', 'Retry the audit.');
  if (typeof v.run_id !== 'string' || v.run_id.length === 0) throw new ApiError('SCAN_FAILED', 'Backend returned an audit without a run_id.', 'Retry the audit.');
  if (typeof v.requested_url !== 'string' || typeof v.final_url !== 'string') throw new ApiError('SCAN_FAILED', 'Backend returned an audit without URLs.', 'Retry the audit.');
  if (!Array.isArray(v.findings) || !(v.findings as unknown[]).every(validateFinding)) throw new ApiError('SCAN_FAILED', 'Backend returned malformed findings.', 'Retry the audit.');
  if (!Array.isArray(v.review_items) || !(v.review_items as unknown[]).every(validateReviewItem)) throw new ApiError('SCAN_FAILED', 'Backend returned malformed review items.', 'Retry the audit.');
  if (typeof v.gate !== 'string' || !VALID_GATES.includes(v.gate as Gate)) throw new ApiError('SCAN_FAILED', 'Backend returned an unknown gate value.', 'Retry the audit.');
  if (!isRecord(v.counts)) throw new ApiError('SCAN_FAILED', 'Backend returned an audit without counts.', 'Retry the audit.');
  return value as unknown as ScanRun;
}

function validateVerificationResult(value: unknown): VerificationResult {
  if (!isRecord(value)) throw new ApiError('SCAN_FAILED', 'Backend returned a malformed verification response.', 'Retry the verification.');
  const v = value as Record<string, unknown>;
  if (v.schema_version !== '1.0') throw new ApiError('SCAN_FAILED', 'Backend returned an unexpected verification schema.', 'Retry the verification.');
  if (typeof v.baseline_id !== 'string' || v.baseline_id.length === 0) throw new ApiError('SCAN_FAILED', 'Backend returned a verification without a baseline_id.', 'Retry the verification.');
  validateScanRun(v.current_run);
  if (!isRecord(v.comparison)) throw new ApiError('SCAN_FAILED', 'Backend returned a verification without a comparison.', 'Retry the verification.');
  if (typeof v.gate !== 'string' || !VALID_GATES.includes(v.gate as Gate)) throw new ApiError('SCAN_FAILED', 'Backend returned an unknown verification gate.', 'Retry the verification.');
  return value as unknown as VerificationResult;
}

export interface PublicTarget {
  label: string;
  url: string;
  role: string;
}

export interface PublicConfig {
  schema_version: string;
  targets: PublicTarget[];
  allowed_hosts?: string[];
  rules?: Array<{ category: string; rule_ids: string[] }>;
  limitations?: string[];
  mcp?: { transport: string; path: string; tools: string[]; stateless: boolean; sessions: boolean };
}

export async function fetchPublicConfig(): Promise<PublicConfig> {
  const raw = await requestJsonGet<unknown>('/api/v1/config');
  if (!isRecord(raw)) throw new ApiError('SCAN_FAILED', 'Backend returned a malformed config.', 'Retry; if it persists, contact the demo operators.');
  const targets = (raw as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) throw new ApiError('SCAN_FAILED', 'Backend config is missing scan targets.', 'Retry; if it persists, contact the demo operators.');
  return raw as unknown as PublicConfig;
}

/** POST /api/v1/audits { url } — always hits the real backend (same-origin by default). */
export async function auditPage(targetUrl: string): Promise<ScanRun> {
  const norm = normalizeTargetUrl(targetUrl);
  if (!norm.valid) {
    throw new ApiError('INVALID_ARGUMENT', norm.error ?? 'Invalid target URL.', 'Enter an absolute http(s) URL from the allowlisted targets below.');
  }
  const raw = await requestJson<unknown>('/api/v1/audits', {
    method: 'POST',
    body: JSON.stringify({ url: norm.url }),
  });
  return validateScanRun(raw);
}

/** POST /api/v1/verifications { url, baseline_id } — same canonical URL as the baseline audit. */
export async function verifyFixes(targetUrl: string, baselineRunId: string): Promise<VerificationResult> {
  const norm = normalizeTargetUrl(targetUrl);
  if (!norm.valid) {
    throw new ApiError('INVALID_ARGUMENT', norm.error ?? 'Invalid target URL.', 'Verify the SAME URL as the baseline audit.');
  }
  if (!baselineRunId || baselineRunId.trim().length === 0) {
    throw new ApiError('INVALID_ARGUMENT', 'A baseline run_id from a prior audit is required.', 'Run an audit first, then verify the same URL against that baseline.');
  }
  const raw = await requestJson<unknown>('/api/v1/verifications', {
    method: 'POST',
    body: JSON.stringify({ url: norm.url, baseline_id: baselineRunId }),
  });
  return validateVerificationResult(raw);
}

/** GET /api/v1/runs/:run_id — fetch a stored run (capability ID, 24h TTL). */
export async function fetchRun(runId: string): Promise<ScanRun> {
  const id = runId.trim();
  if (!id) throw new ApiError('INVALID_ARGUMENT', 'A run_id is required.', 'Use the run_id from a prior audit response.');
  const raw = await requestJsonGet<unknown>(`/api/v1/runs/${encodeURIComponent(id)}`);
  return validateScanRun(raw);
}

/** Helper to compute impact breakdown counts (pure, no network). */
export function countImpacts(findings: Finding[]) {
  return findings.reduce(
    (acc, f) => {
      if (f.impact === 'critical') acc.critical++;
      else if (f.impact === 'serious') acc.serious++;
      else if (f.impact === 'moderate') acc.moderate++;
      else if (f.impact === 'minor') acc.minor++;
      return acc;
    },
    { critical: 0, serious: 0, moderate: 0, minor: 0 },
  );
}
