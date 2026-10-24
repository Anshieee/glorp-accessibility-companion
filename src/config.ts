/**
 * Typed configuration parsed from environment. Throws CONFIGURATION_ERROR
 * (AppError) on invalid env. No auto-allow of arbitrary origins; the demo's
 * own service origin must be supplied explicitly via env before scans.
 */
import path from "node:path";
import { AppError } from "./errors.js";

export interface AppConfig {
  /** Resolved absolute project root (used for web/dist and test/fixtures). */
  projectRoot: string;
  /** Resolved absolute report directory for the local (non-GCS) store. */
  reportDir: string;
  /** GCS bucket name; undefined = use the local filesystem store. */
  bucket: string | undefined;
  /** Exact allowed scan target origins (scheme://host[:port]). No wildcards. */
  allowedOrigins: string[];
  /** Exact allowed scan target hosts. No wildcards, no ports. */
  allowedHosts: string[];
  /** Allow loopback/private targets. Local development ONLY; never on managed cloud. */
  allowLocal: boolean;
  /** Explicit public base URL of this service; never inferred from headers. */
  publicBaseUrl: string | undefined;
  port: number;
  host: string;
  browserExecutable: string | undefined;
  /** Report retention enforced at read time (default 24h). */
  ttlMs: number;
  /** Hard scan timeout budget (default 45s). */
  scanTimeoutMs: number;
  maxStoredBytes: number;
  maxFindings: number;
  readinessSelector: string | undefined;
  rateLimitPerIp: number;
  rateLimitGlobal: number;
  rateLimitWindowMs: number;
  /** Trust exactly one proxy hop (Cloud Run LB) for client IPs. Never enabled by default. */
  trustProxy: boolean;
  /** Optional exact origins permitted for browser CORS. Default: same-origin only. */
  corsOrigins: string[];
  /** Derived directories (not env-configured): */
  webDistDir: string;
  fixturesDir: string;
}

/** Default publicly scannable hosts: exact, selected Indian government domains. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["india.gov.in", "www.india.gov.in"];

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SCAN_TIMEOUT_MS = 45_000;
export const DEFAULT_MAX_STORED_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_MAX_FINDINGS = 100;
export const DEFAULT_RATE_LIMIT_PER_IP = 12; // scans+verifications per window per client IP
export const DEFAULT_RATE_LIMIT_GLOBAL = 60; // hard global scan budget per window
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

function err(attempted: string, detail: string): AppError {
  return new AppError("CONFIGURATION_ERROR", `Invalid configuration: ${attempted}. ${detail}`, "Fix the environment configuration and restart the service.", false);
}

function requireInt(env: NodeJS.Dict<string>, name: string, current: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return current;
  if (!/^\d+$/.test(raw)) throw err(name, `must be a positive integer, got ${JSON.stringify(raw)}.`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) throw err(name, `must be between ${min} and ${max}.`);
  return value;
}

function requireBoolStrict(name: string, raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw err(name, "must be exactly 'true' or 'false'.");
}

/** Exact origins only: scheme://host[:port], no path/query/fragment/wildcard/credentials. */
function parseOrigins(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const candidate = piece.trim();
    if (candidate === "") continue;
    if (candidate === "*" || candidate.includes("*")) throw err(name, `wildcards are not supported; list exact origins (got "${candidate}").`);
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw err(name, `"${candidate}" is not an absolute origin.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw err(name, `${candidate} must be http(s).`);
    if (url.pathname !== "/" && url.pathname !== "") throw err(name, `${candidate} must be an origin with no path.`);
    if (url.search !== "" || url.hash !== "") throw err(name, `${candidate} must not contain query or fragment.`);
    if (url.username !== "" || url.password !== "") throw err(name, `${candidate} must not contain credentials.`);
    const origin = `${url.protocol}//${url.host.toLowerCase()}`;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/** Exact hosts only: no wildcards, no ports, no paths, IPv6 loopback handled via allowLocal. */
function parseHosts(name: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const candidate = piece.trim().toLowerCase();
    if (candidate === "") continue;
    if (candidate === "*" || candidate.includes("*")) throw err(name, `wildcards are not supported; list exact hosts (got "${candidate}").`);
    if (candidate.includes("/") || candidate.includes("@")) throw err(name, `"${candidate}" must be a bare hostname.`);
    if (candidate.includes(":")) throw err(name, `"${candidate}" must be a bare hostname without port (IPv6 allowlisting is not supported; use allow_local for loopback).`);
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

function parseBaseUrl(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw err(name, `"${raw}" is not an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw err(name, "must be http(s).");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw err(name, "must be a bare origin without path, query, fragment or credentials.");
  }
  return `${url.protocol}//${url.host.toLowerCase()}`;
}

export function parseConfig(env: NodeJS.Dict<string> = process.env): AppConfig {
  const projectRoot = path.resolve(env["ACCESSIBILITY_PROJECT_ROOT"] ?? process.cwd());

  // Canonical bucket env: ACCESSIBILITY_REPORT_BUCKET (used by docs/devops).
  // ACCESSIBILITY_GCS_BUCKET remains a backwards-compatible alias. Contradictory
  // dual values are rejected; on managed cloud a real bucket is REQUIRED —
  // otherwise the service would silently persist to the container disk and
  // every reported run would vanish on redeploy.
  const canonicalBucket = env["ACCESSIBILITY_REPORT_BUCKET"]?.trim();
  const aliasBucket = env["ACCESSIBILITY_GCS_BUCKET"]?.trim();
  let bucketRaw: string | undefined;
  if (canonicalBucket !== undefined && canonicalBucket !== "" && aliasBucket !== undefined && aliasBucket !== "" && canonicalBucket !== aliasBucket) {
    throw err(
      "ACCESSIBILITY_REPORT_BUCKET",
      `contradictory bucket configuration: ACCESSIBILITY_REPORT_BUCKET=${canonicalBucket} differs from ACCESSIBILITY_GCS_BUCKET=${aliasBucket}.`,
    );
  }
  bucketRaw = canonicalBucket && canonicalBucket !== "" ? canonicalBucket : aliasBucket;
  if (bucketRaw != null && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,60}$/.test(bucketRaw)) {
    throw err("ACCESSIBILITY_REPORT_BUCKET", "must be a valid GCS bucket name.");
  }

  const allowLocal = requireBoolStrict("ACCESSIBILITY_ALLOW_LOCAL", env["ACCESSIBILITY_ALLOW_LOCAL"]);
  const kService = env["K_SERVICE"];
  const onCloud = typeof kService === "string" && kService !== "";
  if (allowLocal && onCloud) {
    throw err("ACCESSIBILITY_ALLOW_LOCAL", "Loopback/private targets are never permitted on managed cloud (K_SERVICE is set).");
  }
  if (onCloud && (bucketRaw === undefined || bucketRaw === "")) {
    throw err(
      "ACCESSIBILITY_REPORT_BUCKET",
      "missing bucket on managed cloud: set ACCESSIBILITY_REPORT_BUCKET so reports persist and survive service restarts.",
    );
  }

  const allowedOrigins = parseOrigins("ACCESSIBILITY_ALLOWED_ORIGINS", env["ACCESSIBILITY_ALLOWED_ORIGINS"]);
  const allowedHosts = parseHosts("ACCESSIBILITY_ALLOWED_HOSTS", env["ACCESSIBILITY_ALLOWED_HOSTS"]);
  const defaultHosts = DEFAULT_ALLOWED_HOSTS.filter((h) => !allowedHosts.includes(h));
  const allHosts = [...allowedHosts, ...defaultHosts];

  const publicBaseUrl = parseBaseUrl("ACCESSIBILITY_PUBLIC_BASE_URL", env["ACCESSIBILITY_PUBLIC_BASE_URL"]);
  const corsOrigins = parseOrigins("ACCESSIBILITY_CORS_ORIGINS", env["ACCESSIBILITY_CORS_ORIGINS"]);

  const ttlMs = requireInt(env, "ACCESSIBILITY_TTL_MS", DEFAULT_TTL_MS, 60_000, 7 * 24 * 60 * 60 * 1000);
  const scanTimeoutMs = requireInt(env, "ACCESSIBILITY_SCAN_TIMEOUT_MS", DEFAULT_SCAN_TIMEOUT_MS, 1_000, 120_000);
  const maxStoredBytes = requireInt(env, "ACCESSIBILITY_MAX_STORED_BYTES", DEFAULT_MAX_STORED_BYTES, 1024, 100 * 1024 * 1024);
  const maxFindings = requireInt(env, "ACCESSIBILITY_MAX_FINDINGS", DEFAULT_MAX_FINDINGS, 1, 1_000);
  const port = requireInt(env, "PORT", 8080, 1, 65_535);
  const rateLimitPerIp = requireInt(env, "ACCESSIBILITY_RATE_LIMIT_PER_IP", DEFAULT_RATE_LIMIT_PER_IP, 1, 10_000);
  const rateLimitGlobal = requireInt(env, "ACCESSIBILITY_RATE_LIMIT_GLOBAL", DEFAULT_RATE_LIMIT_GLOBAL, 1, 100_000);
  const rateLimitWindowMs = requireInt(env, "ACCESSIBILITY_RATE_LIMIT_WINDOW_MS", DEFAULT_RATE_LIMIT_WINDOW_MS, 1_000, 60 * 60 * 1000);

  const host = env["HOST"]?.trim() || "0.0.0.0";

  return {
    projectRoot,
    reportDir: path.resolve(env["ACCESSIBILITY_REPORT_DIR"]?.trim() || path.join(projectRoot, ".accessibility-mcp", "runs")),
    bucket: bucketRaw && bucketRaw !== "" ? bucketRaw : undefined,
    allowedOrigins,
    allowedHosts: allHosts,
    allowLocal,
    publicBaseUrl,
    port,
    host,
    browserExecutable: env["ACCESSIBILITY_BROWSER_EXECUTABLE"]?.trim() || undefined,
    ttlMs,
    scanTimeoutMs,
    maxStoredBytes,
    maxFindings,
    readinessSelector: env["ACCESSIBILITY_READINESS_SELECTOR"]?.trim() || undefined,
    rateLimitPerIp,
    rateLimitGlobal,
    rateLimitWindowMs,
    trustProxy: requireBoolStrict("ACCESSIBILITY_TRUST_PROXY", env["ACCESSIBILITY_TRUST_PROXY"]),
    corsOrigins,
    webDistDir: path.join(projectRoot, "web", "dist"),
    fixturesDir: path.join(projectRoot, "test", "fixtures"),
  };
}
