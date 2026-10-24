/**
 * HTTP entrypoint for the hosted demo: REST API + Streamable HTTP MCP over one
 * shared scan service. Static frontend (web/dist) and demo fixtures are served
 * from the same process. Diagnostics go to stderr only; nothing is printed to
 * stdout in normal operation.
 *
 * Integration points owned by the engine worker: createScanner (./scanner.js)
 * and compareRuns (./compare.js). The TypeScript build fails until those
 * modules exist — expected deferred compiler error.
 */
import http from "node:http";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import helmet from "helmet";
import type { AppConfig } from "./config.js";
import { parseConfig } from "./config.js";
import { createRunStore } from "./store.js";
import type { RunStore } from "./contracts.js";
import { createService, type AccessibilityService } from "./service.js";
import { createScanner } from "./scanner.js";
import { compareRuns } from "./compare.js";
import { AppError } from "./errors.js";
import type { StoredScan, ScanEngine } from "./contracts.js";
import {
  compactRunFromStored,
  parseAuditPayload,
  parseVerificationPayload,
  validateRunId,
} from "./contracts.js";
import { createMcpRequestHandler, mcpMethodNotAllowed } from "./mcp.js";

const API_BODY_LIMIT_BYTES = 64 * 1024; // request bodies are tiny payloads only

// ---------------------------------------------------------------------------
// Bounded fixed-window rate limiter (per-key + global). The map is hard-bounded
// and swept so it cannot grow without bound.
// ---------------------------------------------------------------------------

class RateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000,
  ) {}

  consume(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    if (this.entries.size > this.maxKeys) this.sweep(now);
    let entry = this.entries.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (entry !== undefined) this.entries.delete(key);
      // Over hard bound even after sweep: drop oldest (insertion order).
      while (this.entries.size >= this.maxKeys) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      entry = { count: 1, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (entry.count >= this.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    entry.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

/**
 * Client IP key. X-Forwarded-For is honored ONLY when ACCESSIBILITY_TRUST_PROXY
 * is configured (one Cloud Run LB hop); otherwise the direct socket address is
 * used and header-spoofed IPs are not keyable.
 */
function clientIpKey(req: Request): string {
  return `ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`;
}

/** Harder guard on scan endpoints (audits/verifications/MCP): per-IP + global budget. */
function scanRateGuard(config: AppConfig): RequestHandler {
  const perIp = new RateLimiter(config.rateLimitPerIp, config.rateLimitWindowMs);
  const global = new RateLimiter(config.rateLimitGlobal, config.rateLimitWindowMs);
  return (req, res, next) => {
    const ipResult = perIp.consume(clientIpKey(req));
    if (!ipResult.allowed) {
      res.set("Retry-After", String(ipResult.retryAfterSeconds));
      next(
        new AppError(
          "RATE_LIMITED",
          "Too many scans from this client in a short window.",
          `Wait ${ipResult.retryAfterSeconds}s and retry; scan capacity is strictly budgeted on this demo.`,
        ),
      );
      return;
    }
    const globalResult = global.consume("global");
    if (!globalResult.allowed) {
      res.set("Retry-After", String(globalResult.retryAfterSeconds));
      next(
        new AppError(
          "RATE_LIMITED",
          "The demo scan budget for this window is exhausted.",
          `Wait ${globalResult.retryAfterSeconds}s and retry.`,
        ),
      );
      return;
    }
    next();
  };
}

/** Lighter guard for read endpoints (reports/config). */
function readRateGuard(config: AppConfig): RequestHandler {
  const perIp = new RateLimiter(config.rateLimitPerIp * 10, config.rateLimitWindowMs);
  return (req, res, next) => {
    const result = perIp.consume(clientIpKey(req));
    if (!result.allowed) {
      res.set("Retry-After", String(result.retryAfterSeconds));
      next(new AppError("RATE_LIMITED", "Too many reads from this client.", `Wait ${result.retryAfterSeconds}s and retry.`));
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Content-Security-Policy: strict self-only baseline for API/frontend/MCP.
// The demo fixtures are locally-authored pages that rely on inline styles and
// handlers (needed to exercise contrast and form/behavior demos), so they get
// a route-scoped CSP with 'unsafe-inline' for script/style ONLY on /fixtures/*.
// ---------------------------------------------------------------------------

const CSP_STRICT = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const CSP_FIXTURES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// Landing page (landing-page/out static export) ships Next's small inline
// bootstrap scripts/styles, so the document + its `/_next/*` assets get a
// route-scoped CSP with 'unsafe-inline' for script/style ONLY on `/` and
// `/_next/*`. Everything else stays strict: no `unsafe-eval`, no remote
// hosts. The demo console (`/console`, web/dist) keeps the strict baseline.
const CSP_LANDING = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function cspMiddleware(landingEnabled = false): RequestHandler {
  return (req, res, next) => {
    const isLandingRoute = landingEnabled && (req.path === "/" || req.path.startsWith("/_next/"));
    const policy = req.path.startsWith("/fixtures/")
      ? CSP_FIXTURES
      : isLandingRoute
        ? CSP_LANDING
        : CSP_STRICT;
    res.setHeader("Content-Security-Policy", policy);
    next();
  };
}

// ---------------------------------------------------------------------------
// CORS: same-origin by default. Extensions of the surface are ONLY exact,
// explicitly configured origins (ACCESSIBILITY_CORS_ORIGINS); never '*' and
// never a trusted echo of the request Origin header. Headers are set BEFORE
// any preflight response status. Same-origin requests (no Origin header) are
// unaffected. With a policy configured, unrelated Origins get no CORS headers
// (browsers block reads) and preflight OPTIONS requests are rejected.
// ---------------------------------------------------------------------------

function corsMiddleware(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || origin === "") {
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
      return;
    }
    if (config.corsOrigins.includes(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "content-type, accept, mcp-protocol-version, mcp-session-id");
      res.set("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
      return;
    }
    // Policy is configured and this Origin is not on it: reject preflight
    // outright; normal requests continue WITHOUT CORS headers (browser blocks).
    if (req.method === "OPTIONS") {
      res
        .status(403)
        .set("Vary", "Origin")
        .json({ execution: "failed", error: { code: "TARGET_NOT_ALLOWED", message: "Origin not permitted by the demo's CORS policy.", recoverable: false, next_action: "Load the demo page from the deployment's own origin." } });
      return;
    }
    res.set("Vary", "Origin");
    next();
  };
}

// ---------------------------------------------------------------------------
// Public config payload (no secrets: no bucket names, paths or report dirs).
// ---------------------------------------------------------------------------

const RULE_CATEGORIES: ReadonlyArray<{ category: string; rule_ids: string[] }> = [
  { category: "Text contrast", rule_ids: ["color-contrast"] },
  { category: "Image alternatives", rule_ids: ["image-alt"] },
  { category: "Form labels", rule_ids: ["label", "select-name"] },
  { category: "Link names", rule_ids: ["link-name"] },
  { category: "Button names", rule_ids: ["button-name"] },
  { category: "Document language", rule_ids: ["html-has-lang", "html-lang-valid"] },
];

const PUBLIC_LIMITATIONS: string[] = [
  "Automated subset only: eight selected axe rules across six categories on one rendered page state (main document only).",
  "Not a full WCAG audit, certification or legal compliance statement.",
  "Menus, modals, other routes, responsive breakpoints, iframes and hidden content are not checked.",
  "Screenshots, cookies and form values are never collected; DOM snippets in findings may contain application content and are rendered as plain text only.",
  "Reports are anonymous, read via unguessable capability IDs; anyone holding an ID can read that report. Reports expire after 24 hours (application-enforced; storage cleanup is eventual).",
  "Missing or visually hidden elements are never reported as fixed; only a fresh same-URL scan is repair evidence.",
  "No login, no crawling, no form submission, no arbitrary remote hosts: scanned targets come only from the configured allowlist.",
  "Hosted demo, not a production service; capacity is deliberately minimal.",
];

/**
 * Public config payload (no secrets: no bucket names, paths or report dirs).
 * Viewport mirrors the engine contract exactly (src/scanner.ts VIEWPORT
 * 1280x800) — the engine owns scan conditions; this page must not guess.
 */
const PUBLIC_VIEWPORT = { width: 1280, height: 800 } as const;

function publicConfigPayload(config: AppConfig): Record<string, unknown> {
  const targets: Array<{ label: string; url: string; role: string }> = [];
  targets.push({
    label: "Accessibility Companion signup fixture — editable flawed demo target (primary demo)",
    url: `${config.publicBaseUrl ?? "<DEPLOYED_BASE_URL>"}/fixtures/registration.html`,
    role: "flawed_fixture_primary_demo",
  });
  targets.push({
    label: "Chosen government domain — read-only real detection only (we never edit government sites)",
    url: "https://www.india.gov.in/",
    role: "government_read_only",
  });
  if (config.publicBaseUrl !== undefined) {
    targets.push({
      label: "Accessibility Companion corrected reference page (optional test page; switching URLs is NOT repair proof)",
      url: `${config.publicBaseUrl}/fixtures/corrected.html`,
      role: "corrected_reference_optional",
    });
    targets.push({
      label: "Accessibility Companion live-demo fixture (same-URL source repair evidence; deployed with the demo)",
      url: `${config.publicBaseUrl}/fixtures/live-demo.html`,
      role: "live_demo_fixture",
    });
  }
  return {
    schema_version: "1.0",
    api_version: "1",
    base_url: config.publicBaseUrl ?? null,
    public_base_url: config.publicBaseUrl ?? null,
    allowed_origins: config.allowedOrigins,
    targets,
    allowed_hosts: config.allowedHosts,
    rules: RULE_CATEGORIES,
    conditions: {
      viewport: { ...PUBLIC_VIEWPORT },
      color_scheme: "light",
      scope: "full_page",
      frame_coverage: "main_document_only",
      current_rendered_state_only: true,
    },
    limitations: PUBLIC_LIMITATIONS,
    mcp: {
      transport: "streamable_http",
      path: "/mcp",
      tools: ["audit_page", "verify_fixes"],
      stateless: true,
      sessions: false,
    },
    report: { retention_hours: 24, anonymous_access: "capability id", storage: "private", id_format: "uuid" },
  };
}

// ---------------------------------------------------------------------------
// Express application
// ---------------------------------------------------------------------------

export interface AppParts {
  config: AppConfig;
  service: AccessibilityService;
  /** Read-only run lookup used by GET /api/v1/runs/:id. */
  loadRun: (id: string) => Promise<StoredScan>;
}

export function buildExpressApp(parts: AppParts): Express {
  const { config, service, loadRun } = parts;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy ? 1 : false);

  // CSP first so helmet's default cannot override it (helmet CSP disabled below).
  // The landing route gets its inline-permitting policy only when the
  // landing-page static export is actually deployed; otherwise `/` keeps the
  // strict baseline with the web/dist fallback.
  const landingDir = path.join(config.projectRoot, "landing-page", "out");
  const landingIndex = path.join(landingDir, "index.html");
  const hasLanding = fsSync.existsSync(landingIndex);
  app.use(cspMiddleware(hasLanding));
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "same-origin" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(corsMiddleware(config));

  const scanGuard = scanRateGuard(config);
  const readGuard = readRateGuard(config);
  const json = express.json({ limit: API_BODY_LIMIT_BYTES, type: "application/json" });

  app.get("/healthz", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ status: "ok", service: "accessibility-companion" });
  });

  app.get("/api/v1/config", readGuard, (_req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    res.json(publicConfigPayload(config));
  });

  app.post("/api/v1/audits", json, scanGuard, (req, res, next) => {
    try {
      const { url } = parseAuditPayload(req.body);
      res.set("Cache-Control", "no-store");
      void service
        .audit(url)
        .then((run) => res.status(200).json(run))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/verifications", json, scanGuard, (req, res, next) => {
    try {
      const { url, baseline_id } = parseVerificationPayload(req.body);
      res.set("Cache-Control", "no-store");
      void service
        .verify(url, baseline_id)
        .then((verification) => res.status(200).json(verification))
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/runs/:runId", readGuard, (req, res, next) => {
    try {
      // Validate the opaque ID first: never treat it as a filesystem path.
      const id = validateRunId(req.params["runId"]);
      res.set("Cache-Control", "no-store");
      void loadRun(id)
        .then((stored) => {
          // GET runs return the compact run only; full findings stay internal.
          res.set("Cache-Control", "private, max-age=0");
          res.status(200).json(compactRunFromStored(stored, config.maxFindings));
        })
        .catch(next);
    } catch (err) {
      next(err);
    }
  });

  // ---- MCP (Streamable HTTP, stateless). Same scan budget applies. ----
  app.post("/mcp", json, scanGuard, createMcpRequestHandler(service));
  app.get("/mcp", mcpMethodNotAllowed);
  app.delete("/mcp", mcpMethodNotAllowed);

  // ---- demo fixtures (routes the frontend and demo loop depend on) ----
  // The fixture allowlist is built ONCE from the actual contents of
  // test/fixtures (engine-owned) at startup; no per-request directory scans,
  // no traversal: only discovered regular files are servable.
  const fixtures = buildFixtureAllowlist(config);
  app.get("/fixtures/:name", readGuard, (req, res, next) => {
    const name = req.params["name"];
    const rawName = typeof name === "string" ? name : Array.isArray(name) ? name.join("/") : "";
    sendFixture(fixtures, rawName, res).catch(next);
  });

  // ---- static frontends: landing page at `/`, demo console at `/console` ----
  // `landing-page/out/` (Next static export) is the served landing experience.
  // `web/dist` (Vite demo console) is preserved at `/console` plus its
  // original root asset URLs for backward compatibility. API/MCP/fixtures
  // routes above are unaffected.
  const webIndex = path.join(config.webDistDir, "index.html");
  const hasWebDist = fsSync.existsSync(webIndex);
  const staticOptions = {
    index: false,
    maxAge: "1h",
    setHeaders: (res: Response, filePath: string) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  };
  if (hasLanding) {
    app.use(express.static(landingDir, staticOptions));
  }
  if (hasWebDist) {
    // redirect:false so GET /console falls through to the SPA fallback below
    // and serves the console index with a 200 (no 301 round-trip).
    app.use("/console", express.static(config.webDistDir, { ...staticOptions, redirect: false }));
    app.use(express.static(config.webDistDir, staticOptions));
  }
  // Demo console SPA fallback: any `/console/*` path serves the console.
  app.get(/^\/console(\/.*)?$/, (req, res) => {
    if (!hasWebDist) {
      notFoundHandler(req, res);
      return;
    }
    void fs
      .readFile(webIndex)
      .then((html) => res.status(200).type("html").set("Cache-Control", "no-cache").send(html))
      .catch(() => res
        .status(500)
        .type("html")
        .send("<!doctype html><html lang=\"en\"><title>Accessibility Companion</title><h1>Accessibility Companion</h1><p>Frontend index unreadable.</p></body></html>"));
  });
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path !== "/") {
      notFoundHandler(req, res);
      return;
    }
    if (hasLanding) {
      void fs
        .readFile(landingIndex)
        .then((html) => res.status(200).type("html").set("Cache-Control", "no-cache").send(html))
        .catch(() => res
          .status(500)
          .type("html")
          .send("<!doctype html><html lang=\"en\"><title>Accessibility Companion</title><h1>Accessibility Companion</h1><p>Landing index unreadable.</p></body></html>"));
      return;
    }
    if (hasWebDist) {
      void fs
        .readFile(webIndex)
        .then((html) => res.status(200).type("html").set("Cache-Control", "no-cache").send(html))
        .catch(() => res
          .status(500)
          .type("html")
          .send("<!doctype html><html lang=\"en\"><title>Accessibility Companion</title><h1>Accessibility Companion</h1><p>Frontend index unreadable.</p></body></html>"));
      return;
    }
    res
      .status(200)
      .type("html")
      .set("Cache-Control", "no-store")
      .send(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Accessibility Companion</title></head>" +
        "<body><h1>Accessibility Companion</h1><p>Backend is running. The demo frontend is not built in this deployment; " +
        "the HTTP API and MCP server are available.</p><p>See <code>GET /api/v1/config</code>.</p></body></html>",
      );
  });

  app.use(errorHandler);
  return app;
}

interface FixtureEntry {
  /** Absolute path of the real file on disk (engine-owned; never renamed). */
  filePath: string;
  contentType: string;
}

type FixtureAllowlist = ReadonlyMap<string, FixtureEntry>;

const FIXTURE_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

/**
 * Enumerate the fixture directory ONCE. Stable URL names the frontend uses:
 *  - registration.html  → test/fixtures/registration.html
 *  - corrected.html     → alias of the engine's registration-corrected.html
 *                         (engine files are NOT renamed)
 *  - live-demo.html     → same-URL source-repair evidence page (deployed with
 *                         the demo; alias of itself — served once created)
 * Any other regular file with an approved extension present in the directory
 * is served under its own name; nothing outside test/fixtures is reachable.
 */
function buildFixtureAllowlist(config: AppConfig): FixtureAllowlist {
  const map = new Map<string, FixtureEntry>();
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = fsSync.readdirSync(config.fixturesDir, { withFileTypes: true }) as never;
  } catch {
    // Directory missing in this build: fixtures return a truthful error.
    return map;
  }
  const aliasOf = new Map<string, string>([
    ["corrected.html", "registration-corrected.html"],
    ["live-demo.html", "live-demo.html"],
  ]);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const contentType = FIXTURE_CONTENT_TYPES[ext];
    if (contentType === undefined) continue;
    // Defense in depth: resolve and confirm containment before allowing.
    const filePath = path.resolve(config.fixturesDir, entry.name);
    if (!filePath.startsWith(path.resolve(config.fixturesDir) + path.sep)) continue;
    map.set(entry.name, { filePath, contentType });
  }
  for (const [routeName, realName] of aliasOf) {
    if (map.has(realName) && !map.has(routeName)) {
      map.set(routeName, map.get(realName) as FixtureEntry);
    }
  }
  return map;
}

async function sendFixture(fixtures: FixtureAllowlist, name: string, res: Response): Promise<void> {
  const entry = fixtures.get(name);
  if (entry === undefined) {
    const available = [...fixtures.keys()].filter((k) => k.endsWith(".html")).sort();
    const malformed = name === "" || name.includes("/") || name.includes("\\");
    const err = new AppError(
      malformed ? "INVALID_ARGUMENT" : "TARGET_UNREACHABLE",
      malformed ? "Invalid fixture name." : `Fixture ${name} is not deployed in this build.`,
      malformed
        ? "Use the documented /fixtures/... routes."
        : available.length > 0
          ? `Use one of the deployed fixtures: ${available.join(", ")}.`
          : "No fixtures are available in this build.",
    );
    res.status(err.status).json(err.toBody());
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(entry.filePath);
  } catch {
    const err = new AppError(
      "TARGET_UNREACHABLE",
      `Fixture ${name} is not readable in this build.`,
      "Ask the demo operators to redeploy the test/fixtures files.",
    );
    res.status(err.status).json(err.toBody());
    return;
  }
  res
    .status(200)
    .type(entry.contentType)
    .set("Cache-Control", "no-store")
    .set("X-Content-Type-Options", "nosniff")
    .send(bytes);
}

function notFoundHandler(req: Request, res: Response): void {
  const err = new AppError(
    "INVALID_ARGUMENT",
    `No route: ${req.method} ${req.path}.`,
    "Use GET /api/v1/config to discover endpoints.",
  );
  res.status(404).json(err.toBody());
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let appErr: AppError | undefined = err instanceof AppError ? err : undefined;
  if (appErr === undefined) {
    const type = typeof err === "object" && err !== null ? (err as { type?: string }).type : undefined;
    if (type === "entity.parse.failed") {
      appErr = new AppError("INVALID_ARGUMENT", "Request body must be valid JSON.", "Send application/json with a well-formed body.");
    }
  }
  if (appErr !== undefined) {
    res.status(appErr.status).json(appErr.toBody());
    return;
  }
  console.error(`[http] unexpected error on ${req.method} ${req.path}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  appErr = new AppError(
    "SCAN_FAILED",
    "Unexpected server error while processing the request.",
    "Retry the request; if it persists, contact the demo operators.",
    false,
  );
  res.status(appErr.status).json(appErr.toBody());
}

// ---------------------------------------------------------------------------
// Boot + graceful shutdown
// ---------------------------------------------------------------------------

export interface RunningServer {
  server: http.Server;
  service: AccessibilityService;
  port: number;
  close(): Promise<void>;
}

export async function startServer(
  config: AppConfig = parseConfig(),
  engineOverride?: ScanEngine,
  storeOverride?: RunStore,
): Promise<RunningServer> {
  // createScanner builds the engine synchronously (lazy browser launch) and
  // opens the EgressProxy child. From that point on, EVERY startup failure
  // must close the engine again — otherwise the proxy keeps the child process
  // alive and a failed `node dist/server.js` (e.g. listen EADDRINUSE when the
  // port is taken by an unrelated service) hangs forever instead of exiting.
  let engine: ScanEngine;
  if (engineOverride !== undefined) {
    engine = engineOverride;
  } else {
    engine = await (createScanner(config) as ScanEngine | Promise<ScanEngine>);
  }

  /**
   * Best-effort engine shutdown for failed-startup cleanup: the EgressProxy
   * child keeps the process alive, so a failed `node dist/server.js` must
   * always close the engine before the error propagates. This includes
   * override engines — on the failure path the caller never receives a
   * RunningServer, so there is no double-close risk.
   */
  const closeEngineQuietly = async (): Promise<void> => {
    await engine.close().catch((err: unknown) => {
      console.error(`[startup-cleanup] engine close failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };

  try {
    const store =
      storeOverride ??
      createRunStore({
        reportDir: config.reportDir,
        ttlMs: config.ttlMs,
        maxStoredBytes: config.maxStoredBytes,
        gcsBucket: config.bucket,
      });
    const service = createService({ engine, store, compareRuns, maxFindings: config.maxFindings });
    const app = buildExpressApp({ config, service, loadRun: (id) => store.load(id) });

    const server = http.createServer(app);
    server.requestTimeout = 120_000;
    server.headersTimeout = 65_000;
    server.keepAliveTimeout = 65_000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : config.port;

    const close = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await engine.close().catch((err: unknown) => {
        console.error(`[shutdown] engine close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    };

    return { server, service, port: boundPort, close };
  } catch (err) {
    // Store/service/app construction or HTTP listen failed (listen EADDRINUSE,
    // EACCES, ...): shut the engine (and its EgressProxy child) back down so a
    // failed startup exits promptly instead of hanging on the proxy handle.
    await closeEngineQuietly();
    throw err;
  }
}

function describeStartup(config: AppConfig): void {
  const lines = [
    `listening on http://${config.host}:${config.port}`,
    `report store: ${config.bucket !== undefined ? `GCS bucket ${config.bucket}` : `filesystem ${config.reportDir}`}`,
    `allowed origins: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(", ") : "(none extra)"}`,
    `allowed hosts: ${config.allowedHosts.join(", ")}`,
    `allow_local: ${String(config.allowLocal)}`,
  ];
  for (const line of lines) console.error(`[server] ${line}`);
}

async function main(): Promise<void> {
  const config = parseConfig();
  let stopping = false;
  let running: RunningServer;
  try {
    running = await startServer(config);
  } catch (err) {
    console.error(`[server] startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  describeStartup(config);
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.error(`[server] received ${signal}, shutting down gracefully`);
    const forceExit = setTimeout(() => {
      console.error("[server] forced exit after 20s grace period");
      process.exit(1);
    }, 20_000);
    void running
      .close()
      .then(() => {
        clearTimeout(forceExit);
        process.exit(0);
      })
      .catch((err) => {
        console.error(`[server] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        clearTimeout(forceExit);
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Run only as the direct entrypoint; imported by tests without side effects.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  void main();
}
