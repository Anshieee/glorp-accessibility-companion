/**
 * Scan engine (engine worker).
 *
 * One lazily-launched, shared Playwright Chromium process per engine; one scan
 * at a time (SCAN_BUSY, no queue); an isolated context per invocation closed in
 * finally; a hard 45 s (configurable) total bound including browser launch
 * (launch races + closes the browser if the budget expires — no late process
 * leak). Every network destination flows through the engine's loopback egress
 * proxy (src/network.ts); main-frame navigation is additionally blocked by the
 * Playwright route guard BEFORE the request leaves the browser. axe runs on
 * the main document only (iframes: false) with the eight-rule run-only set and
 * full outcome accounting. An empty/unusable target is gate=not_evaluated —
 * never a pass.
 */
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext, type Page, type Request as PlaywrightRequest, type Route } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { AppError } from "./errors.js";
import type { AppConfig } from "./config.js";
import {
  type Finding,
  type Gate,
  type ReviewItem,
  type ScanEngine,
  type ScanRun,
  type StoredScan,
} from "./contracts.js";
import {
  REQUIRED_RULE_IDS,
  assertRequiredRulesAvailable,
  assertRuleOutcomesAccounted,
  getRuleDefinition,
  rulesetFingerprint,
} from "./rules.js";
import { computeOutcomeGate, normalizeAxeResults, type NormalizedOutcome } from "./normalize.js";
import {
  EgressProxy,
  assertMainFrameDestinationAllowed,
  buildOriginsCache,
  normalizeHostname,
  parseAllowedAssetOrigins,
  validateTargetUrl,
  type AllowedOriginsCache,
} from "./network.js";

const require = createRequire(import.meta.url);

const VIEWPORT = { width: 1280, height: 800 } as const;
const BROWSER_LOCALE = "en-US";
export const PASS_COMPLETION_CLAIM =
  "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review.";
export const NOT_EVALUATED_COMPLETION_CLAIM =
  "The page could not be meaningfully evaluated; no automated checks were assessed, so nothing passed.";
export const REVIEW_REQUIRED_COMPLETION_CLAIM =
  "Selected automated checks found no violations, but engine results or required review items are incomplete; human review is required before claiming a review to be unnecessary.";

/** Bounds for tearing down a context/browser after a scan (ms). */
const CONTEXT_CLOSE_BOUND_MS = 3_000;
const BROWSER_CLOSE_BOUND_MS = 2_000;

/**
 * Resolve with `promise`'s value if it settles within `ms`, otherwise with
 * `fallback`. The timer is always cleared (no dangling timers after the race).
 */
async function settleWithin<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const BASE_LAUNCH_ARGS = [
  // Required in typical cloud/container runtimes (no IPC namespace); this is a
  // demo-scoped control, noted honestly as such in limitations.
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  // No QUIC; WebRTC IP handling set to its DOCUMENTED value
  // (disable_non_proxied_udp — "disable_webrtc" is not a valid value). Only
  // non-proxied UDP egress is prevented by the flag; TURN over TCP and other
  // relay paths are NOT blocked by it. Actual media/socket controls are
  // additionally frozen by context init scripts, and nothing bypasses the
  // proxy (fetch/XHR/WebSocket all need the validated egress).
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  // Everything — including loopback destinations — flows through the proxy so
  // it can validate every destination (`<-loopback>` = do NOT bypass loopback).
  "--proxy-bypass-list=<-loopback>",
];

/**
 * Frozen restricted-capability init script (runs in every frame of every
 * page/popup created in the context): removes the global constructors for
 * real-time communication and raw transports so page scripts cannot attempt
 * non-proxied egress or arbitrary transports. delete-freeze (prototype-chain
 * writes) cannot bypass defineProperty(configurable:false). This is a
 * proportional capability restriction of the demo browser, NOT a sandbox
 * claim: a compromised renderer outside this closure is out of scope.
 */
const RESTRICTED_CAPS_INIT = (): void => {
  const g = globalThis as unknown as Record<string, unknown>;
  const ban = (name: string): void => {
    try {
      Object.defineProperty(g, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // Failing to freeze is not a crash; egress proxy policy still applies.
    }
  };
  ban("RTCPeerConnection");
  ban("webkitRTCPeerConnection");
  ban("RTCDataChannel");
  ban("WebTransport");
  const navigatorValue = g["navigator"] as
    | { mediaDevices?: Record<string, unknown>; getUserMedia?: unknown; webkitGetUserMedia?: unknown; mozGetUserMedia?: unknown }
    | undefined;
  const banNav = (host: unknown, name: string): void => {
    try {
      Object.defineProperty(host as object, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // ignore
    }
  };
  if (navigatorValue) {
    if (navigatorValue.mediaDevices) {
      banNav(navigatorValue.mediaDevices, "getUserMedia");
      banNav(navigatorValue.mediaDevices, "getDisplayMedia");
    }
    banNav(navigatorValue, "getUserMedia");
    banNav(navigatorValue, "webkitGetUserMedia");
    banNav(navigatorValue, "mozGetUserMedia");
  }
};

interface AxeRawResults {
  violations: unknown;
  passes: unknown;
  incomplete: unknown;
  inapplicable: unknown;
  testEngine?: { version?: string };
}

function isLaunchLikeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /Failed to launch|Executable doesn't exist|Process closed with signal|browserType\.launch/.test(message) ||
    (err as NodeJS.ErrnoException)?.code === "ENOENT"
  );
}

/**
 * True when the navigation error itself already identifies a client-side
 * block (in which case mapNavigationError maps it to TARGET_NOT_ALLOWED on
 * its own and the route-guard flag is not needed to disambiguate).
 */
function mainFrameNavigationDenied(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message);
}

/** Normalized hostname of an absolute URL, or null when it cannot be parsed. */
function hostOfUrl(raw: string): string | null {
  try {
    return normalizeHostname(new URL(raw).hostname);
  } catch {
    return null;
  }
}

function mapNavigationError(err: unknown): AppError {
  const message = err instanceof Error ? err.message : String(err);
  if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message)) {
    return new AppError(
      "TARGET_NOT_ALLOWED",
      "Navigation to a destination outside the configured allowlist was blocked before the request.",
      "Scan only URLs on the configured allowlist (fixture or government hosts).",
    );
  }
  // Playwright's TimeoutError: name carries the type; the message is
  // "Timeout <n>ms exceeded" without the word "timed out".
  if (err instanceof Error && err.name === "TimeoutError") {
    return new AppError(
      "SCAN_TIMEOUT",
      "The page did not load within the scan time budget.",
      "Retry; if it persists, the target is too slow for the demo budget.",
    );
  }
  if (/ERR_TIMED_OUT|TimeoutError|timed out/i.test(message)) {
    return new AppError(
      "SCAN_TIMEOUT",
      "The page did not load within the scan time budget.",
      "Retry; if it persists, the target is too slow for the demo budget.",
    );
  }
  if (/ERR_CONNECTION_REFUSED|ERR_CANCELLED|ERR_SSL|ERR_NAME_NOT_RESOLVED|ERR_PROXY_CONNECTION_FAILED|net::ERR/i.test(message)) {
    return new AppError(
      "TARGET_UNREACHABLE",
      "The configured page could not be reached through the scan browser.",
      "Verify the target is on the configured allowlist, publicly reachable and serving a page, then retry.",
    );
  }
  throw err instanceof AppError ? err : new AppError("SCAN_FAILED", "Unexpected failure while scanning.", "Retry the scan; if it persists, contact the operators.", false);
}

type EngineState =
  | { phase: "idle" }
  | { phase: "scanning" }
  | { phase: "launching"; promise: Promise<Browser> }
  | { phase: "ready"; browser: Browser };

/**
 * Engine factory. Starts the loopback egress proxy eagerly (so a browser
 * process can never exist without the validating proxy) and returns the shared
 * engine. One process, one scan at a time.
 */
export async function createScanner(config: AppConfig): Promise<ScanEngine> {
  if (config.allowLocal && process.env["K_SERVICE"] !== undefined) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "allowLocal must never be enabled on the hosted cloud service (K_SERVICE is set).",
      "Start the service with allowLocal disabled; loopback/private scanning is local-dev only.",
      false,
    );
  }
  const originCache = buildOriginsCache(config);
  // Exact HTTPS asset origins come from the engine's own env var (documented
  // coordination contract with deployment config; not a new root config field):
  // ACCESSIBILITY_ALLOWED_ASSET_ORIGINS = comma-separated exact origins
  // (scheme://host[:port]) that tunnelled (CONNECT) subresources may reach.
  const { raw: assetOriginsRaw } = parseAllowedAssetOrigins(process.env);
  const proxy = new EgressProxy(config, originCache, { assetOrigins: assetOriginsRaw });
  const proxyPort = await proxy.start();
  return new AccessibilityScanEngine(config, proxy, proxyPort, originCache);
}

class AccessibilityScanEngine implements ScanEngine {
  private state: EngineState = { phase: "idle" };
  private closed = false;
  private activeContexts = 0;
  /** True while a scan body is executing (one scan at a time, SCAN_BUSY). */
  private scanning = false;
  private axeEngineMeta: { version: string; sourceSha256: string; source: string | undefined } | null = null;

  /** Visible for tests/service: number of browser contexts currently open. */
  get activeContextCount(): number {
    return this.activeContexts;
  }

  constructor(
    private readonly config: AppConfig,
    private readonly proxy: EgressProxy,
    private readonly proxyPort: number,
    private readonly originCache: AllowedOriginsCache,
  ) {}

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  private remainingMs(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  private async withBudget<T>(promise: Promise<T>, ms: number, code: () => AppError): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return (await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(code()), ms);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ])) as T;
    } finally {
      // Always clear: an unresolved budget timer must not outlive the race
      // (no dangling rejection later in the test/process lifetime).
      if (timer) clearTimeout(timer);
    }
  }

  private async ensureBrowser(deadline: number): Promise<Browser> {
    if (this.state.phase === "ready") {
      try {
        if (this.state.browser.isConnected()) return this.state.browser;
      } catch {
        // fall through and relaunch
      }
      this.state = { phase: "idle" };
    }
    if (this.closed) {
      throw new AppError("SCAN_FAILED", "The scan engine has been shut down.", "Start a new engine instance.", false);
    }
    if (this.state.phase === "launching") {
      const pending = this.state.promise;
      return await this.wrapLaunchFailure(
        this.withBudget(
          pending,
          this.remainingMs(deadline),
          () => new AppError("SCAN_TIMEOUT", "Browser startup exceeded the scan time budget.", "Retry the scan."),
        ),
      );
    }

    const launchTimeout = Math.min(20_000, Math.max(1_000, this.remainingMs(deadline)));
    const launchPromise = chromium
      .launch({
        headless: true,
        executablePath: this.config.browserExecutable,
        timeout: launchTimeout,
        args: [...BASE_LAUNCH_ARGS, `--proxy-server=http://127.0.0.1:${this.proxyPort}`],
      })
      .catch((err) => {
        if (this.state.phase === "launching") this.state = { phase: "idle" };
        if (isLaunchLikeError(err)) {
          throw new AppError(
            "BROWSER_UNAVAILABLE",
            "The scan browser is unavailable in this environment.",
            `Install Playwright's chromium (npx playwright install chromium) or set ACCESSIBILITY_BROWSER_EXECUTABLE (current: ${this.config.browserExecutable ?? "unset"}).`,
            false,
          );
        }
        throw err;
      });
    launchPromise.catch(() => undefined); // avoid unhandled rejection noise
    // Belt and braces: no late process leak even if every caller races away.
    this.withBudget(launchPromise, launchTimeout, () =>
      new AppError("SCAN_TIMEOUT", "Browser startup exceeded the scan time budget.", "Retry the scan."),
    ).catch(() => {
      launchPromise
        .then((b) => b.close().catch(() => undefined))
        .catch(() => undefined);
      if (this.state.phase === "launching") this.state = { phase: "idle" };
    });

    this.state = { phase: "launching", promise: launchPromise };
    return await this.wrapLaunchFailure(
      this.withBudget(
        launchPromise,
        this.remainingMs(deadline),
        () => new AppError("SCAN_TIMEOUT", "Browser startup exceeded the scan time budget.", "Retry the scan."),
      ),
    );
  }

  private async wrapLaunchFailure(p: Promise<Browser>): Promise<Browser> {
    let browser: Browser;
    try {
      browser = await p;
    } catch (err) {
      if (this.state.phase === "launching") this.state = { phase: "idle" };
      throw err;
    }
    browser.on("disconnected", () => {
      if (this.state.phase === "ready" && this.state.browser === browser) this.state = { phase: "idle" };
    });
    this.state = { phase: "ready", browser };
    return browser;
  }

  // -------------------------------------------------------------------------
  // Public scan entry point
  // -------------------------------------------------------------------------

  async scan(rawUrl: string): Promise<StoredScan> {
    if (this.closed) {
      throw new AppError("SCAN_FAILED", "The scan engine has been shut down.", "Start a new engine instance.", false);
    }
    const target = validateTargetUrl(rawUrl, this.config, this.originCache);
    if (this.scanning) {
      throw new AppError(
        "SCAN_BUSY",
        "Another scan is currently running; the demo engine runs exactly one scan at a time.",
        "Retry the scan shortly (after the previous scan completes).",
      );
    }
    this.scanning = true;
    const startedAt = Date.now();
    const deadline = startedAt + this.config.scanTimeoutMs;
    let context: BrowserContext | undefined;
    let browser: Browser | undefined;
    try {
      browser = await this.ensureBrowser(deadline);
      // Late-context reaping: if the budget expires while newContext is still
      // pending, the resolved context is closed instead of leaking.
      const createContext = browser.newContext({
        viewport: VIEWPORT,
        colorScheme: "light",
        locale: BROWSER_LOCALE,
        serviceWorkers: "block",
        ignoreHTTPSErrors: false,
        acceptDownloads: false,
      });
      context = await this.withBudget(
        createContext,
        this.remainingMs(deadline),
        () => new AppError("SCAN_TIMEOUT", "Browser context setup exceeded the scan time budget.", "Retry the scan."),
      ).catch((err: unknown) => {
        void createContext
          .then((late) => {
            void late.close().catch(() => undefined);
          })
          .catch(() => undefined);
        throw err;
      });
      this.activeContexts += 1;
      // HARD deadline: the entire scan body (newPage, navigation, readiness,
      // evaluations, axe) races against the SAME remaining budget; on expiry
      // nothing later than this instant can extend the scan.
      return await this.withBudget(
        this.runScan(context, target, startedAt, deadline),
        this.remainingMs(deadline),
        () => new AppError(
          "SCAN_TIMEOUT",
          "The scan exceeded its total time budget.",
          "Retry the scan; if it persists, the target is too slow for the demo budget.",
        ),
      );
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new AppError(
          "SCAN_TIMEOUT",
          "The scan exceeded its total time budget.",
          "Retry the scan; if it persists, the target is too slow for the demo budget.",
        );
      }
      throw err;
    } finally {
      if (context) {
        this.activeContexts -= 1;
        await this.closeContextBounded(context, browser);
      }
      // Release the single-scan lock; `state` tracks the browser lifecycle
      // ("ready"/"idle") and is managed by the launch path, not here.
      this.scanning = false;
    }
  }

  /**
   * Bounded context teardown. If context.close() does not complete within its
   * bound, the browser is asked to close (bounded) and the engine drops it from
   * its lifecycle state, so the NEXT scan relaunches instead of reusing a wedged
   * browser. A stuck scan never permanently closes the engine (only an explicit
   * close() does). See the process-lingering limitation noted in closeContextBounded.
   */
  private async closeContextBounded(context: BrowserContext, browser: Browser | undefined): Promise<void> {
    const closed = await settleWithin(
      context.close().then(
        () => true,
        () => true,
      ),
      CONTEXT_CLOSE_BOUND_MS,
      false,
    );
    if (closed) return;
    // The context did not close in time: the browser is treated as wedged.
    // Ask it to close (bounded, public API only). Whatever the outcome, the
    // engine forgets this browser so the NEXT scan launches a fresh one rather
    // than reusing a wedged instance. Honest limitation: Playwright exposes no
    // public handle to the browser process, so if close never completes the old
    // process may linger; this code does not force-kill it.
    if (browser) {
      await settleWithin(
        browser.close().then(
          () => undefined,
          () => undefined,
        ),
        BROWSER_CLOSE_BOUND_MS,
        undefined,
      );
      if (this.state.phase === "ready" && this.state.browser === browser) {
        this.state = { phase: "idle" };
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scan body
  // -------------------------------------------------------------------------

  private async runScan(
    context: BrowserContext,
    target: ReturnType<typeof validateTargetUrl>,
    startedAt: number,
    deadline: number,
  ): Promise<StoredScan> {
    const page: Page = await context.newPage();
    const mainFrame = page.mainFrame();
    const warnings: string[] = [];
    let blockedMutations = 0;
    let blockedTransports = 0;
    let popupsClosed = 0;
    // Monotonic refusal snapshot taken BEFORE any page activity; refusals are
    // attributed by destination host below.
    const refusalsAtStart = this.proxy.totalRefusalCount;
    // Hosts the PAGE itself requested (every request event in this context).
    // A refusal counts as rendering-relevant only for these hosts: Chromium's
    // own background services (update/autofill/etc.) also go through the proxy
    // but are not page content.
    const pageRequestHosts = new Set<string>();
    context.on("request", (req: PlaywrightRequest) => {
      const host = hostOfUrl(req.url());
      if (host !== null) pageRequestHosts.add(host);
    });

    // Restricted capabilities (WebRTC / user media / raw transports) frozen by
    // init script in EVERY frame of every page in this context. Recorded as a
    // rendering limitation; never claimed as a sandbox.
    await context.addInitScript(RESTRICTED_CAPS_INIT);

    // WebSockets are blocked as defense for static targets. Close on
    // "request", before any page content; oversized traffic never starts.
    try {
      const wsPattern = "**/*";
      await context.routeWebSocket(wsPattern, (ws) => {
        blockedTransports += 1;
        this.proxy.note(`websocket blocked (context guard): ${ws.url()}`);
        ws.close();
      });
    } catch {
      warnings.push("WebSocket blocking could not be installed in this browser build; page scripts could keep long-lived connections open (egress proxy still validates every destination).");
    }
    // WebTransport alternative: frozen by the init script above.

    // Close script-opened popups: the scan is single-page by contract, so any
    // window.open from the target is shut. Crucially this closes ONLY windows
    // that a page opened (page "popup" events, plus any popup-of-popup whose
    // opener is set). Pages created by the SDK itself (axe-core's aggregation
    // helper page, created via context.newPage(), has no opener) are left
    // alone: closing them breaks axe's finishRun ("Target page ... closed").
    // A popup can be seen by both listeners below: count and close it once.
    const closedPopups = new WeakSet<Page>();
    const closePopup = (popup: Page): void => {
      if (popup === page || closedPopups.has(popup)) return;
      closedPopups.add(popup);
      popupsClosed += 1;
      void popup.close().catch(() => undefined);
    };
    page.on("popup", closePopup);
    context.on("page", (newPage) => {
      if (newPage === page) return;
      void newPage
        .opener()
        .then((opener) => {
          if (opener !== null) closePopup(newPage);
        })
        .catch(() => undefined);
    });

    // telemetry for the goto catch. Playwright does NOT re-intercept redirect
    // continuation requests in route handlers, so every navigation request in
    // the context (including popups and redirect legs, all seen via events) is
    // classified and consulted when a navigation fails.
    let lastMainFrameRequestDenied = false;
    context.on("request", (request: PlaywrightRequest) => {
      if (!request.isNavigationRequest()) return;
      const frame = request.frame();
      const reqPage = frame?.page();
      if (!frame || !reqPage || reqPage.mainFrame() !== frame) return;
      lastMainFrameRequestDenied = !this.mainFrameRequestAllowed(request.url());
    });
    // Set SYNCHRONOUSLY by the route guard when it blocks a top-level
    // navigation; used by the goto catch to attribute blocked-redirect
    // failures (cross-origin redirect targets abort as net::ERR_FAILED/
    // ABORTED, not always ERR_BLOCKED_BY_CLIENT).
    let mainFrameNavigationBlocked = false;

    // Context-level request guard (defense in depth over the egress proxy):
    //  - EVERY top-level navigation (request.frame() === the frame's own page
    //    main-frame — covers the original page AND popups) must be exactly on
    //    the allowlist or it is aborted BEFORE the request leaves.
    //  - All other requests are GET/HEAD only; mutating methods are blocked
    //    statically (no form interactions here, but scripts could PUT/POST —
    //    policy: a scan is a read-only evaluation of a rendered state).
    await context.route("**/*", async (route: Route) => {
      try {
        const request = route.request();
        const method = request.method().toUpperCase();
        // Method policy FIRST, for every request including top-level
        // navigations (a scripted auto-submit POST must not reach the network).
        if (method !== "GET" && method !== "HEAD") {
          blockedMutations += 1;
          this.proxy.note(`mutating request blocked (${method}): ${request.url()}`, hostOfUrl(request.url()));
          await route.abort("blockedbyclient");
          return;
        }
        const frame = request.frame();
        const reqPage = frame?.page() ?? null;
        // Requests from any page other than the scanned one are refused. The
        // SDK helper page issues no network requests and script popups are
        // closed, so nothing legitimate is lost; this is defense in depth.
        if (reqPage !== null && reqPage !== page) {
          this.proxy.note(`request from a non-scanned page blocked: ${request.url()}`, hostOfUrl(request.url()));
          await route.abort("blockedbyclient");
          return;
        }
        const isTopNav = request.isNavigationRequest() && frame !== null && reqPage !== null && reqPage.mainFrame() === frame;
        if (isTopNav) {
          const denied = !this.mainFrameRequestAllowed(request.url());
          if (denied) {
            this.proxy.note(`main-frame destination blocked by route guard: ${request.url()}`, hostOfUrl(request.url()));
            if (frame === mainFrame) mainFrameNavigationBlocked = true;
            else lastMainFrameRequestDenied = true;
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
          return;
        }
        await route.continue();
      } catch {
        await route.abort("blockedbyclient").catch(() => undefined);
      }
    });

    // Navigate (bounded). Response/redirect semantics checked below.
    const response = await page
      .goto(target.canonical, { waitUntil: "domcontentloaded", timeout: Math.max(1_000, this.remainingMs(deadline)) })
      .catch((err: unknown): never => {
        // A denied main-frame leg (redirect continuation caught by the proxy —
        // route interception does not see those — or the route guard itself)
        // must be reported as TARGET_NOT_ALLOWED, not a generic network error.
        if ((mainFrameNavigationBlocked || lastMainFrameRequestDenied) && !mainFrameNavigationDenied(err)) {
          throw new AppError(
            "TARGET_NOT_ALLOWED",
            "A navigation/redirect destination outside the configured allowlist was blocked before the request.",
            "Scan only URLs whose entire redirect chain stays on the configured allowlist.",
          );
        }
        throw mapNavigationError(err);
      });
    if (response === null || response.status() === 0 || !response.ok()) {
      const status = response ? response.status() : 0;
      throw new AppError(
        "TARGET_UNREACHABLE",
        status > 0
          ? `The page returned HTTP ${status}; error responses are fatal for scans even if the error document could be scanned.`
          : "The page could not be loaded; no successful response was observed.",
        "Fix the target so it returns a successful page response.",
      );
    }

    // Final destination validation (covers redirects that completed).
    const finalUrlRaw = page.url();
    if (!this.mainFrameRequestAllowed(finalUrlRaw)) {
      throw new AppError(
        "TARGET_NOT_ALLOWED",
        "The final destination after redirects is outside the configured allowlist.",
        "Scan only URLs whose entire redirect chain stays on the configured allowlist.",
      );
    }
    const finalCanonical = canonicalOf(finalUrlRaw);
    if (finalCanonical !== target.canonical) {
      warnings.push(
        `Target redirected to ${finalCanonical}; baselines still compare on the requested canonical URL. Same-URL verification after a source repair requires a URL that lands on this same final state.`,
      );
    }

    // Fonts settle (bounded); failure just warns and downgrades an otherwise
    // clean outcome (contrast may have been measured against unfinished
    // styles). Never upgrades a fail.
    const fontsSettled = await Promise.race([
      page
        .evaluate((): boolean | Promise<boolean> => {
          type FontShim = { fonts?: { ready?: Promise<void> } };
          const fonts = (globalThis as { document?: FontShim }).document?.fonts;
          if (!fonts?.ready) return true;
          return fonts.ready.then(() => true);
        })
        .catch(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(1_000, Math.floor(this.remainingMs(deadline) / 5)));
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (!fontsSettled) warnings.push("Fonts did not settle before the scan; rendered text metrics may still be loading.");

    // Optional readiness selector with its own budget (no arbitrary JS in
    // input). Runs BEFORE the meaningfulness check so an initially-empty SPA
    // (hydrated only at ready time) is not misjudged as empty.
    if (this.config.readinessSelector) {
      try {
        await page.waitForSelector(this.config.readinessSelector, {
          state: "attached",
          timeout: Math.max(1_000, this.remainingMs(deadline) - 3_000),
        });
      } catch {
        throw new AppError(
          "TARGET_NOT_READY",
          `The configured readiness selector did not appear in time: ${this.config.readinessSelector}.`,
          "Verify the page reaches its ready state within the scan budget.",
        );
      }
    }

    // Meaningfulness check over VISIBLE elements: bounding box, computed
    // display/visibility/opacity, and either nonempty rendered text or a
    // visible interactive/media element. Hidden inputs or zero-size elements
    // (display:none, type=hidden) do NOT make a target meaningful.
    const meaningful = await page
      .evaluate((): boolean => {
        type ElementShim = {
          getBoundingClientRect?: () => { width: number; height: number };
          innerText?: string;
        };
        type StyleShim = { display?: string; visibility?: string; opacity?: string };
        type DocShim = {
          body?: ElementShim | null;
          querySelectorAll?: (selector: string) => ArrayLike<ElementShim & { tagName?: string }>;
          defaultView?: { getComputedStyle?: (el: unknown) => StyleShim } | null;
        };
        const doc = (globalThis as { document?: DocShim }).document;
        const win = doc?.defaultView;
        const getStyle = (el: unknown): StyleShim | null => {
          try {
            return win?.getComputedStyle?.(el) ?? null;
          } catch {
            return null;
          }
        };
        const isVisible = (el: ElementShim): boolean => {
          const rect = el.getBoundingClientRect?.();
          if (!rect || rect.width <= 0 || rect.height <= 0) return false;
          const style = getStyle(el);
          if (!style) return true; // style lookup unavailable: rect evidence only
          if (style.display === "none" || style.visibility === "hidden") return false;
          const opacity = Number.parseFloat(style.opacity ?? "1");
          if (Number.isFinite(opacity) && opacity === 0) return false;
          return true;
        };
        const body = doc?.body;
        if (!body) return false;
        if ((body.innerText?.trim() ?? "").length > 0) return true;
        const nodes = doc?.querySelectorAll?.("a, button, input, select, textarea, img, svg, video, canvas, table") ?? [];
        const list = Array.from(nodes);
        let inspected = 0;
        for (const el of list) {
          if (inspected >= 500) break; // bounded; a real page has visible content far earlier
          inspected += 1;
          const style = getStyle(el);
          const type = (el as unknown as { tagName?: string }).tagName ?? "";
          if (type === "INPUT" && (style?.display === "none" || (el as unknown as { type?: string }).type === "hidden")) {
            continue; // hidden form fields are not user-visible content
          }
          if (isVisible(el)) return true;
        }
        return false;
      })
      .catch(() => false);
    if (!meaningful) {
      warnings.push("The page had no meaningful VISIBLE body text or interactive/visual elements; no checks were evaluated.");
      return this.buildStoredScan({
        outcome: null,
        gate: "not_evaluated",
        startedAt,
        requestedUrl: target.canonical,
        finalUrl: finalCanonical,
        pageTitle: "",
        warnings,
      });
    }

    // Frame coverage: main_document_only. axe configured for iframes too.
    const frameCount = page.frames().length;
    if (frameCount > 1) {
      warnings.push(
        `The page contains ${frameCount} frame(s) (including nested). Only the main document was evaluated; embedded frame contents were NOT checked (frame coverage: main_document_only).`,
      );
    }

    // Verify the actually-injected engine's axe exposes every required rule
    // (axe.getRules against the runtime). CSP failure degrades to outcome
    // accounting — still a hard RULESET_UNSUPPORTED if outcomes are missing.
    const axeEngine = await this.axeEngineMetadata(page);
    try {
      await page.addScriptTag({ content: axeEngine.source ?? "", type: "text/javascript" });
    } catch {
      warnings.push(
        "axe source could not be pre-verified via script injection (page policy); rule availability verified by strict outcome accounting instead.",
      );
    }
    try {
      const availability = await page.evaluate((): string[] => {
        const axeGlobal = (globalThis as Record<string, unknown>)["axe"] as
          | { getRules?: () => unknown }
          | undefined;
        if (!axeGlobal?.getRules) return [];
        // axe-core <4.14 returns an object keyed by rule id; 4.14+ returns a
        // list of rule metadata objects carrying a `ruleId` field. Support
        // both shapes.
        const ids: string[] = [];
        for (const [key, entry] of Object.entries(axeGlobal.getRules() as Record<string, unknown>)) {
          if (entry && typeof entry === "object" && typeof (entry as { ruleId?: unknown })["ruleId"] === "string") {
            ids.push((entry as { ruleId: string })["ruleId"]);
          } else if (typeof entry === "string") {
            ids.push(entry);
          } else {
            ids.push(key);
          }
        }
        return ids;
      });
      if (availability.length > 0) {
        assertRequiredRulesAvailable(availability);
      }
    } catch (err) {
      if (err instanceof AppError && err.code === "RULESET_UNSUPPORTED") throw err;
      warnings.push("Rule availability could not be confirmed in-page; strict outcome accounting still applies after the run.");
    }

    // Run axe: only the eight required rules, main document only, with all
    // four outcome buckets materialized for full accounting.
    const remaining = Math.max(1_000, this.remainingMs(deadline) - 2_000);
    // Note: AxeBuilder#options OVERRIDES withRules/withTags, so the run-only
    // rule selection must live inside the single options object.
    const axeResults = await this.withBudget(
      new AxeBuilder({ page, axeSource: axeEngine.source })
        .options({
          iframes: false,
          runOnly: { type: "rule", values: [...REQUIRED_RULE_IDS] },
          resultTypes: ["passes", "violations", "incomplete", "inapplicable"],
        })
        .analyze() as Promise<AxeRawResults>,
      remaining,
      () => new AppError("SCAN_TIMEOUT", "The axe analysis exceeded the scan time budget.", "Retry the scan."),
    );

    const normalized = normalizeAxeResults(axeResults);
    // Strict accounting: every required rule must appear in one outcome bucket.
    assertRuleOutcomesAccounted(new Set([...normalized.evaluatedRuleIds, ...normalized.inapplicableRuleIds]));

    // Egress honesty: any refusal during the scan (see remoteAssetsBlocked
    // above) means requests were blocked and the page may render incompletely.
    // That uncertainty is reported as a review item and downgrades an otherwise
    // clean outcome; it NEVER upgrades a failure.
    if (blockedMutations > 0) {
      warnings.push(
        `${blockedMutations} mutating request(s) (non GET/HEAD) were blocked by the request guard; a scan is a read-only evaluation of the rendered state.`,
      );
    }
    if (blockedTransports > 0) {
      warnings.push(
        `${blockedTransports} WebSocket connection attempt(s) were blocked by the engine (long-lived connections are out of scope for a static-state scan).`,
      );
    }
    if (popupsClosed > 0) {
      warnings.push(
        `${popupsClosed} popup window(s) opened by the page were closed; the scan covers only the main page.`,
      );
    }
    // Refusals during this scan that concern the PAGE: every refusal whose
    // destination the page requested, plus every refusal with no attributable
    // destination (conservative). Counted from the monotonic log (not the
    // bounded message log, so repeated identical refusals are never hidden).
    // Chromium-internal background traffic refused by the proxy is excluded:
    // it is not page content. If the per-refusal log was trimmed, the raw
    // count delta is used (conservative).
    const refusedHosts = this.proxy.refusalHostsSince(refusalsAtStart);
    const remoteAssetsBlocked =
      refusedHosts === null
        ? this.proxy.totalRefusalCount - refusalsAtStart
        : refusedHosts.filter((host) => host === null || pageRequestHosts.has(host)).length;
    if (remoteAssetsBlocked > 0) {
      warnings.push(
        `${remoteAssetsBlocked} network request(s) were refused during the scan by the egress policy or the request guard (remote assets outside the egress allowlist are the usual cause); the page may render incompletely and some checks may be evaluated against missing styles/images. Set ACCESSIBILITY_ALLOWED_ASSET_ORIGINS with the exact origins the target genuinely requires, then rescan.`,
      );
      normalized.reviewItems.push({
        rule_id: "engine-egress",
        // Whole-document concern: anchored on the root element. A review item
        // with no target is rejected by the stored-record validator, which made
        // the saved baseline unloadable (BASELINE_NOT_FOUND on verify).
        targets: ["html"],
        reason:
          "Network request(s) were refused during the scan (egress allowlist or request guard); the rendered state may be incomplete and the automated result may not cover everything a full render would expose. Review the page with the required asset origins configured before trusting a clean result.",
        html: null,
      });
    }
    if (this.axeEngineMeta === null || this.axeEngineMeta.version === "") {
      warnings.push("Engine version could not be determined; the outcome cannot be treated as a verified pass.");
    }

    const pageTitle = await page.title().catch(() => "");
    const gate: Gate = computeOutcomeGate(normalized, {
      engineVersionKnown: this.axeEngineMeta !== null && this.axeEngineMeta.version !== "",
      remoteAssetsBlocked,
      fontsUnsettled: !fontsSettled,
    });

    return this.buildStoredScan({
      outcome: normalized,
      gate,
      startedAt,
      requestedUrl: target.canonical,
      finalUrl: finalCanonical,
      pageTitle,
      warnings,
    });
  }

  private assertMainFrameNavigable(scheme: "http" | "https", hostname: string, port: number): boolean {
    return assertMainFrameDestinationAllowed(scheme, hostname, port, this.config, this.originCache);
  }

  /** Allowlist decision for an arbitrary absolute URL (main-frame policy). */
  private mainFrameRequestAllowed(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return false;
    }
    const scheme: "http" | "https" = url.protocol === "https:" ? "https" : "http";
    const port = url.port === "" ? (scheme === "https" ? 443 : 80) : Number(url.port);
    return this.assertMainFrameNavigable(scheme, url.hostname, port);
  }

  private async axeEngineMetadata(page: Page): Promise<{ version: string; sourceSha256: string; source: string | undefined }> {
    if (this.axeEngineMeta) return this.axeEngineMeta;
    let source: string | undefined;
    let sha256 = "";
    try {
      const sourcePath = require.resolve("axe-core/axe.min.js");
      source = readFileSync(sourcePath, "utf8");
      sha256 = createHash("sha256").update(source).digest("hex");
    } catch {
      // Source unavailable; accounting below still applies.
    }
    let version: string;
    try {
      version = (require("axe-core/package.json") as { version: string }).version;
    } catch {
      version = "";
    }
    this.axeEngineMeta = { version, sourceSha256: sha256, source };
    void page;
    return this.axeEngineMeta;
  }

  // -------------------------------------------------------------------------
  // Run record assembly
  // -------------------------------------------------------------------------

  private buildStoredScan(input: {
    outcome: NormalizedOutcome | null;
    gate: Gate;
    startedAt: number;
    requestedUrl: string;
    finalUrl: string;
    pageTitle: string;
    warnings: string[];
  }): StoredScan {
    const completedAtWall = Date.now();
    const runId = randomUUID();
    const startedIso = new Date(input.startedAt).toISOString();
    const completedIso = new Date(completedAtWall).toISOString();
    const durationMs = completedAtWall - input.startedAt;

    const findings: Finding[] = input.outcome?.findings ?? [];
    const reviewItems: ReviewItem[] = input.outcome?.reviewItems ?? [];
    const maxFindings = Math.max(1, this.config.maxFindings);
    const returnedFindings = findings.slice(0, maxFindings);
    const returnedReview = reviewItems.slice(0, maxFindings);
    const omitted = findings.length - returnedFindings.length;
    const reviewOmitted = reviewItems.length - returnedReview.length;
    const detailsTruncated = omitted > 0 || reviewOmitted > 0;

    const warnings = input.warnings.slice();
    if (omitted > 0) {
      warnings.push(
        `${omitted} additional finding(s) omitted from the returned details (returned cap: ${maxFindings}); full findings are in the stored report.`,
      );
    }
    if (reviewOmitted > 0) {
      warnings.push(
        `${reviewOmitted} additional review item(s) omitted from the returned details; full review items are in the stored report.`,
      );
    }

    // Opaque relative reference agreed with the store contract; never bucket
    // names or absolute filesystem paths.
    const reportPath = `runs/${runId}.json`;

    const run: ScanRun = {
      schema_version: "1.0",
      run_id: runId,
      execution: "completed",
      started_at: startedIso,
      completed_at: completedIso,
      duration_ms: durationMs,
      requested_url: input.requestedUrl,
      final_url: input.finalUrl,
      page_title: input.pageTitle,
      conditions: {
        viewport: { ...VIEWPORT },
        color_scheme: "light",
        browser_locale: BROWSER_LOCALE,
        readiness_selector: this.config.readinessSelector ?? null,
        scope: "full_page",
      },
      engine: {
        axe_version: this.axeEngineMeta?.version || "",
        playwright_version: PLAYWRIGHT_VERSION,
        rule_ids: [...REQUIRED_RULE_IDS],
        ruleset_fingerprint: rulesetFingerprint(this.axeEngineMeta?.version || "", this.axeEngineMeta?.sourceSha256 || undefined),
      },
      coverage: {
        categories: this.categoriesOf(input.outcome),
        evaluated_rule_ids: input.outcome?.evaluatedRuleIds ?? [],
        inapplicable_rule_ids: input.outcome?.inapplicableRuleIds ?? [],
        incomplete_rule_ids: input.outcome?.incompleteRuleIds ?? [],
        current_rendered_state_only: true,
        frame_coverage: "main_document_only",
      },
      counts: {
        violation_rule_count: input.outcome?.counts.violationRuleCount ?? 0,
        violation_node_count: input.outcome?.counts.violationNodeCount ?? 0,
        incomplete_node_count: input.outcome?.counts.incompleteNodeCount ?? 0,
        returned_finding_count: returnedFindings.length,
        omitted_finding_count: omitted,
      },
      findings: returnedFindings,
      review_items: returnedReview,
      gate: input.gate,
      details_truncated: detailsTruncated,
      report_path: reportPath,
      warnings,
      limitations: this.limitations(input.outcome === null),
    };

    return {
      run,
      full_findings: findings,
      full_review_items: reviewItems,
      evidence: input.outcome?.evidence ?? {},
    };
  }

  private categoriesOf(outcome: NormalizedOutcome | null): string[] {
    if (!outcome) return [];
    const categories = new Set<string>();
    for (const id of [...outcome.evaluatedRuleIds, ...outcome.inapplicableRuleIds]) {
      const def = getRuleDefinition(id);
      if (def) categories.add(def.category);
    }
    return [...categories].sort();
  }

  private limitations(notEvaluated: boolean): string[] {
    const base = [
      "Automated subset only: eight axe rules across six categories on one rendered page state — not full WCAG conformance, certification or full accessibility.",
      "Only the main document is evaluated (frame coverage: main_document_only); iframe contents are not checked even when the page has iframes.",
      "Only the current rendered state at scan time is checked; other routes, menus, breakpoints and later interactions are outside this run.",
      "Browser locale is not evidence for page language repairs; page content language must be verified against real content.",
      "The hosted browser fetches only through a validating egress proxy (public/allowlisted destinations); this is a proportional demo control, not an absolute sandbox, and snippets are best-effort redacted untrusted content.",
      "Requests are read-only (GET/HEAD) and long-lived transports (WebSockets/WebTransport) are frozen or closed; real-time media/WebRTC globals are frozen by init scripts. These are capability restrictions of the demo browser only — flags do not block TURN relay over TCP by themselves, and none of this is a sandbox claim.",
      "HTTPS egress is restricted to the configured main allowlist plus exact configured asset origins (ACCESSIBILITY_ALLOWED_ASSET_ORIGINS). Remote assets outside those origins are refused and reported as incomplete-rendering review, never silently treated as absent.",
      "Chromium runs with --no-sandbox (a container/cloud runtime requirement, accepted as a demo-scoped control). The renderer sandbox is therefore NOT active; the scan relies on the egress proxy and context request guard, and this is not a sandbox claim.",
      "Restricted browser capabilities (WebRTC peer connections, user media, WebTransport) are frozen by an init script as an intentional demo restriction; pages that depend on them may render differently from a normal browser.",
      "Embedded iframe contents are not evaluated (frame coverage: main_document_only). Frame presence is reported as a warning only by accepted policy; it becomes a review item only when axe reports an incomplete outcome.",
    ];
    if (notEvaluated) {
      return [
        "An unusable/empty target cannot be evaluated; a tool error, missing browser or empty scan is never reported as a pass.",
        ...base,
      ];
    }
    return base;
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    this.closed = true;
    if (this.state.phase === "launching") {
      const pending = this.state.promise;
      this.state = { phase: "idle" };
      await pending
        .then((b) => b.close())
        .catch(() => undefined);
    }
    if (this.state.phase === "ready") {
      const browser = this.state.browser;
      this.state = { phase: "idle" };
      if (browser.isConnected()) await browser.close().catch(() => undefined);
    }
    await this.proxy.stop();
  }
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

const requirePkg = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION: string = (() => {
  try {
    return (requirePkg("playwright/package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

function canonicalOf(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}
