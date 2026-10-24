/**
 * Network security layer (engine worker).
 *
 * The hosted browser runs in a cloud service; all of its egress flows through
 * a local loopback HTTP proxy that implements the demo's safe-public-network
 * policy (HACKATHON_TEAM_HANDOFF §2.2):
 *
 *  - Top scan targets must be http(s) URLs with no embedded credentials, on an
 *    exactly-configured allowlist (allowedOrigins exact match, or allowedHosts
 *    with default ports 80/443). No suffix matches, no wildcards.
 *  - `allowLocal` (local tests/dev ONLY, never on K_SERVICE) additionally
 *    permits exactly-allowlisted loopback origins via the proxy.
 *  - Every proxied destination (main frame, subresource, subframe) is
 *    validated; DNS resolves in the proxy with lookup(all:true); ANY
 *    loopback/private/reserved/link-local/multicast/metadata/CGNAT address
 *    rejects the request (ipaddr.js, robust IPv4 + IPv6 incl. v4-mapped
 *    unwrap). The socket connects directly to the verified public IP — no
 *    second DNS lookup by any library — which is the DNS-rebinding control.
 *  - CONNECT parsing is IPv6-robust; header sizes and timeouts are bounded;
 *    sockets are tracked and cleaned up at close.
 *
 * This is a proportional, demo-scoped control. It is NOT claimed to be an
 * absolute sandbox: the target page is untrusted content and an attacker-
 * controlled page could still reach allowlisted public sites.
 */
import http from "node:http";
import net from "node:net";
import dns from "node:dns";
import { createRequire } from "node:module";
import ipaddr from "ipaddr.js";
import { AppError } from "./errors.js";
import type { AppConfig } from "./config.js";
import { parseTargetUrl, canonicalTarget, type ScanEngine } from "./contracts.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Pure host/IP classification helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Canonical host name: lowercase, no IPv6 brackets, no trailing dot. */
export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".") && !h.startsWith(".")) h = h.slice(0, -1);
  return h;
}

export type IpClass = "public" | "loopback" | "restricted";

/**
 * Classify an IP literal with ipaddr.js. IPv4-mapped IPv6 (::ffff:10.0.0.1) is
 * unwrapped and re-classified against IPv4 ranges, so mapped private/metadata
 * addresses cannot masquerade as public.
 */
export function classifyIp(ipRaw: string): IpClass {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    // ipaddr.js parses IPv4-mapped IPv6 literals, zone ids and plain IPv4.
    const candidate: unknown = ipaddr.parse(ipRaw);
    if (candidate == null || typeof candidate !== "object") return "restricted";
    parsed = candidate as ipaddr.IPv4 | ipaddr.IPv6;
  } catch {
    return "restricted";
  }
  if (typeof parsed.kind !== "function") return "restricted";
  let kind = parsed.kind();
  let rangeName = parsed.range();
  if (kind === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress?.() === true) {
      const v4 = v6.toIPv4Address();
      kind = "ipv4";
      rangeName = v4.range();
    }
  }
  switch (rangeName) {
    case "loopback":
      return "loopback";
    case "unicast":
      // 'unicast' is the default range bucket in ipaddr.js: globally routable.
      return "public";
    default:
      // unspecified, broadcast, multicast, linkLocal (metadata), private,
      // carrierGradeNat, reserved, uniqueLocal, ipv4Mapped, rfc6145, rfc6052,
      // 6to4, teredo, benchmarking, as112 → non-public/unusable.
      return "restricted";
  }
}

export function isLoopbackHostname(host: string): boolean {
  const h = normalizeHostname(host);
  if (h === "localhost" || h.endsWith(".localhost") === true) return true;
  const c = classifyIp(h);
  return c === "loopback";
}

export function isIpLiteral(host: string): boolean {
  try {
    const parsed = ipaddr.parse(normalizeHostname(host));
    return parsed != null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL target validation (top-level scan target)
// ---------------------------------------------------------------------------

const TRAVERSAL_RE = /(?:^|\/)\.\.?(?:\/|$)|%2e%2e|%2E%2E/i;

export interface ValidatedTarget {
  /** Canonical absolute URL (whitespace-trimmed, as-given path). */
  url: string;
  /** Canonical URL with fragment stripped (baseline comparability form). */
  canonical: string;
  scheme: "http" | "https";
  hostname: string;
  port: number;
  origin: string;
}

export function hasUrlTraversal(raw: string): boolean {
  // Only inspect the URL body before any query/fragment; browser-facing path
  // traversal attempts ('..' or their percent encodings) are rejected early.
  const qIndex = raw.search(/[?#]/);
  const body = qIndex === -1 ? raw : raw.slice(0, qIndex);
  return TRAVERSAL_RE.test(body);
}

export function effectivePort(protocol: "http:" | "https:", port: string): number {
  const parsed = Number.parseInt(port, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return protocol === "https:" ? 443 : 80;
}

/** Scheme-agnostic normalized form used to compare against allowedOrigins. */
export function normalizedOrigin(scheme: "http" | "https", hostname: string, port: number): string {
  const effective = scheme === "https" ? (port === 443 ? 443 : port) : port === 80 ? 80 : port;
  return `${scheme}://${normalizeHostname(hostname)}:${effective}`;
}

function normalizeAllowedOriginEntry(entry: string): string | null {
  try {
    const url = new URL(entry);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalizedOrigin(url.protocol === "https:" ? "https" : "http", url.hostname, effectivePort(url.protocol, url.port));
  } catch {
    return null;
  }
}

export interface AllowedOriginsCache {
  origins: Set<string>;
  hosts: Set<string>;
}

export function buildOriginsCache(config: Pick<AppConfig, "allowedOrigins" | "allowedHosts">): AllowedOriginsCache {
  const origins = new Set<string>();
  for (const o of config.allowedOrigins) {
    const n = normalizeAllowedOriginEntry(o);
    if (n) origins.add(n);
  }
  const hosts = new Set<string>();
  for (const h of config.allowedHosts) {
    const n = normalizeHostname(h);
    if (n) hosts.add(n);
  }
  return { origins, hosts };
}

/**
 * Validate the top-level scan target URL: scheme, credentials, traversal
 * attempts and allowlist membership (exact only). Proxy unreachable/private
 * checks happen additionally at egress time.
 */
export function validateTargetUrl(raw: string, config: AppConfig, cache?: AllowedOriginsCache): ValidatedTarget {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "url is required and must be an absolute http(s) URL.",
      "Provide an absolute http(s) URL on exactly the configured allowlist.",
    );
  }
  if (/\s/.test(raw)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "url must not contain whitespace.",
      "Provide a single absolute http(s) URL.",
    );
  }
  if (hasUrlTraversal(raw)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "url must not contain path traversal segments.",
      "Provide the exact public page URL without '..' segments.",
    );
  }
  // parseTargetUrl handles: absolute URL, http/https only, credentials, '@'.
  const parsed = parseTargetUrl(raw);
  const originCache = cache ?? buildOriginsCache(config);
  const scheme: "http" | "https" = parsed.protocol === "https:" ? "https" : "http";
  const hostname = normalizeHostname(parsed.hostname);
  const port = effectivePort(parsed.protocol as "http:" | "https:", parsed.port);
  if (!assertMainFrameDestinationAllowed(scheme, hostname, port, config, originCache)) {
    throw new AppError(
      "TARGET_NOT_ALLOWED",
      "Target is not on the configured allowlist. Public scans are restricted to allowlisted fixture/government hosts.",
      "Use one of the exact configured allowed origins/hosts.",
    );
  }
  const canonical = canonicalTarget(raw);
  // canonicalTarget already strips the fragment; URL canon may append slash.
  return { url: parsed.toString(), canonical, scheme, hostname, port, origin: `${scheme}://${hostname}:${port}` };
}

/**
 * Main-frame destination eligibility (applied to the requested URL, every
 * main-frame navigation request caught by Playwright routing, and any final
 * destination after redirects). Exact allowlist only.
 */
export function isMainFrameDestinationAllowed(
  scheme: "http" | "https",
  hostnameRaw: string,
  port: number,
  config: AppConfig,
  cache?: AllowedOriginsCache,
): boolean {
  const originCache = cache ?? buildOriginsCache(config);
  if (!assertMainFrameDestinationAllowed(scheme, hostnameRaw, port, config, originCache)) return false;
  return true;
}

/**
 * Strict internal decision. Enforces, in order (allowlist before IP policy:
 * a public allowlisted host comes first; private/loopback is gated by
 * allowLocal + explicit origin membership; everything else rejects):
 */
export function assertMainFrameDestinationAllowed(
  scheme: "http" | "https",
  hostnameRaw: string,
  port: number,
  config: AppConfig,
  cache: AllowedOriginsCache,
): boolean {
  const hostname = normalizeHostname(hostnameRaw);

  // Reject non-public IP literals outright before allowlist logic.
  if (isIpLiteral(hostname)) {
    const cls = classifyIp(hostname);
    if (cls === "restricted") return false;
    if (cls === "loopback" && !config.allowLocal) return false;
  }

  const origin = normalizedOrigin(scheme, hostname, port);
  // Step 1: exact allowlisted origin (any scheme/port as configured).
  if (cache.origins.has(origin)) {
    // Loopback origins additionally require allowLocal.
    if (isIpLiteral(hostname) && classifyIp(hostname) === "loopback" && !config.allowLocal) return false;
    if (!isIpLiteral(hostname) && isLoopbackHostname(hostname) && !config.allowLocal) return false;
    return true;
  }
  // Step 2: exact allowlisted host with default scheme port (80/443 only).
  if (cache.hosts.has(hostname)) {
    const defaultPort = scheme === "https" ? 443 : 80;
    if (port === defaultPort) return true;
    return false; // custom ports are only permitted via exact origin allowlist
  }
  return false;
}

/**
 * Optional exact egress allowlist for HTTPS subresource (asset) origins,
 * parsed from the engine's OWN env var (no change to the shared root config
 * shape): `ACCESSIBILITY_ALLOWED_ASSET_ORIGINS` = comma-separated exact
 * origins (scheme://host[:port]). Empty by default. Coordination note for the
 * orchestrator/backend: this env is documented for service deployment config
 * (e.g. fonts/CDN hosts actually required by scan targets). There is no way to
 * change the policy at runtime via a request argument.
 */
export function parseAllowedAssetOrigins(env: NodeJS.ProcessEnv): { origins: Set<string>; raw: string[] } {
  const raw = (env["ACCESSIBILITY_ALLOWED_ASSET_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const origins = new Set<string>();
  for (const entry of raw) {
    const n = normalizeAllowedOriginEntry(entry);
    if (n) origins.add(n);
  }
  return { origins, raw };
}

/**
 * Exact HTTPS-origin egress decision for tunnelled (CONNECT) destinations.
 * The demo policy is STRICT: a CONNECT may only go to
 *  - an exact allowlisted main origin (any configured allowedOrigins entry),
 *  - or an exact configured asset origin (metrics: fonts/CDN style
 *    resources that scan targets legitimately need),
 *  - or, for local tests only (allowLocal), exactly-allowlisted loopback
 *    origins.
 * Restricted IP literals are rejected outright, ALWAYS (even if allowlisted),
 * including any host that would DNS-resolve to a restricted address.
 */
export function assertTunnelSubresourceAllowed(
  scheme: "http" | "https",
  hostnameRaw: string,
  port: number,
  config: AppConfig,
  cache: AllowedOriginsCache,
  assetOrigins: Set<string>,
): boolean {
  const hostname = normalizeHostname(hostnameRaw);

  if (isIpLiteral(hostname)) {
    const cls = classifyIp(hostname);
    if (cls === "restricted") return false;
    if (cls === "loopback") {
      if (!config.allowLocal) return false;
      const origin = normalizedOrigin(scheme, hostname, port);
      return cache.origins.has(origin) || assetOrigins.has(origin);
    }
  }

  const origin = normalizedOrigin(scheme, hostname, port);
  if (cache.origins.has(origin) || assetOrigins.has(origin)) return true;
  // Exact allowlisted host with its default scheme port behaves like the
  // main-frame policy: allowlisted hosts may serve their own subresources.
  if (cache.hosts.has(hostname)) {
    const defaultPort = scheme === "https" ? 443 : 80;
    if (port === defaultPort) return true;
  }
  return false;
}

/**
 * Subresource (non-main-frame, non-tunnelled plain-HTTP) destination decision:
 * any public host is permitted on the default ports only; custom ports require
 * an exact origin allowlist entry (asset origins count as such entries for
 * custom ports). Private/reserved addresses never transit.
 */
export function assertSubresourceDestinationAllowed(
  scheme: "http" | "https" | null,
  hostnameRaw: string,
  port: number,
  config: AppConfig,
  cache: AllowedOriginsCache,
  assetOrigins: Set<string> = new Set(),
): boolean {
  const hostname = normalizeHostname(hostnameRaw);

  if (isIpLiteral(hostname)) {
    const cls = classifyIp(hostname);
    if (cls === "restricted") return false;
    if (cls === "loopback") {
      // Loopback subresources only via allowLocal + exact origin allowlist.
      if (!config.allowLocal) return false;
      const inferred = scheme ?? (port === 443 ? "https" : "http");
      return cache.origins.has(normalizedOrigin(inferred, hostname, port));
    }
  }

  // Default ports are fine for any public host (public egress policy for
  // plain-HTTP assets). To avoid collapsing policy claims into one boolean,
  // tunnelled (CONNECT/HTTPS) destinations use assertTunnelSubresourceAllowed
  // instead — HTTPS-with-any-public-host is NOT part of this decision.
  if (port === 80 || port === 443) {
    // Plain http assets on 80 remain the ordinary public-asset policy.
    if (scheme === "http" && port === 80) return true;
    // For unspecified/other schemes on these ports, keep the historical
    // public-port allowance (proxy-level policy handles HTTPS CONNECT
    // separately).
    if (scheme === null) return true;
    // https on 443 for a public host is only cleared here when it is an exact
    // main or asset allowlist origin; otherwise the CONNECT path decides.
    const origin = normalizedOrigin("https", hostname, port);
    return cache.origins.has(origin) || assetOrigins.has(origin);
  }

  // Custom ports need an exact allowlisted origin (main or asset).
  const inferred = scheme ?? (port === 443 ? "https" : "http");
  const origin = normalizedOrigin(inferred, hostname, port);
  return cache.origins.has(origin) || assetOrigins.has(origin);
}

// ---------------------------------------------------------------------------
// CONNECT target parsing (IPv6 robust)
// ---------------------------------------------------------------------------

export interface ConnectTarget {
  host: string;
  port: number;
}

export function parseConnectTarget(raw: string): ConnectTarget | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 512) return null;
  if (!value.includes(":")) return null;
  if (value.startsWith("[")) {
    // [::1]:443 / [2001:db8::1]:8443 — strictly digits, no junk bytes.
    const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
    if (!match) return null;
    const port = Number.parseInt(match[2], 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null;
    return { host: match[1], port };
  }
  // Plain IPv6 like ::1:443 is ambiguous and MUST be bracketed; only allow
  // a single colon on the right with strictly numeric digits. The digit-only
  // regex rejects trailing junk such as `:443junk` and leading garbage.
  const match = /^([^:\s]+):(\d{1,5})$/.exec(value);
  if (!match) return null;
  const host = match[1];
  if (host.includes("]")) return null;
  if (host.includes(":")) return null; // multi-colon host without brackets
  const port = Number.parseInt(match[2], 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null;
  return { host, port };
}

// ---------------------------------------------------------------------------
// DNS resolution with public-address pinning
// ---------------------------------------------------------------------------

export interface PinnedResolution {
  address: string;
  all: string[];
}

/**
 * Resolve a host with lookup(all:true) and require EVERY resolved address to
 * be acceptable. `allowLoopback` is granted only when the destination already
 * passed allowlist eligibility (exact loopback origin + config.allowLocal).
 * Returns the pinned, verified acceptable address; the proxy then connects
 * directly to it, so no downstream library performs a second DNS lookup
 * (DNS-rebinding control). Lookup errors map to TARGET_UNREACHABLE.
 */
export async function resolvePinnedHost(
  hostRaw: string,
  options: { allowLoopback: boolean; timeoutMs?: number },
): Promise<PinnedResolution> {
  const host = normalizeHostname(hostRaw);

  if (isIpLiteral(host)) {
    const cls = classifyIp(host);
    if (cls === "public") return { address: host, all: [host] };
    if (cls === "loopback" && options.allowLoopback) return { address: host, all: [host] };
    throw new AppError(
      "TARGET_NOT_ALLOWED",
      "Destination resolves to a non-public address; private/unusable networks are not reachable in this hosted demo.",
      "Use a publicly routable host that is on the configured allowlist.",
    );
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    throw new AppError(
      "TARGET_UNREACHABLE",
      code === "ENOTFOUND" || code === "EAI_AGAIN" ? `Host "${host}" could not be resolved.` : `DNS lookup failed for "${host}".`,
      "Verify the target host exists and is publicly reachable.",
    );
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError("TARGET_UNREACHABLE", `Host "${host}" could not be resolved.`, "Verify the target host exists.");
  }

  const all = records.map((r) => r.address);
  for (const address of all) {
    const cls = classifyIp(address);
    if (cls === "public") continue;
    if (cls === "loopback" && options.allowLoopback) continue;
    throw new AppError(
      "TARGET_NOT_ALLOWED",
      `Host "${host}" resolves to a non-public address (${address}); private, link-local, metadata or otherwise unusable networks are rejected to prevent SSRF and DNS rebinding.`,
      "Use a publicly routable host that is on the configured allowlist.",
    );
  }

  // Deterministic pin: first acceptable record (verbatim DNS order).
  return { address: all[0], all };
}

// ---------------------------------------------------------------------------
// Egress proxy (forward HTTP + CONNECT, bounded)
// ---------------------------------------------------------------------------

const MAX_HEADER_BYTES = 32 * 1024;
/** Bound on the per-refusal host log (see EgressProxy.refusalHostsSince). */
const REFUSAL_HOST_LOG_CAP = 5_000;
const HEADER_WAIT_TIMEOUT_MS = 10_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const TUNNEL_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const HTTP_FORBIDDEN =
  "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const HTTP_BAD_GATEWAY =
  "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** Hop-by-hop request headers that must NOT be relayed on the upstream leg. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function classifyFetchDest(raw: string | null): "mainframe" | "subresource" {
  // Conservative default: absent fetch metadata behaves like a main frame so
  // non-browser raw clients cannot sneak an unrestricted destination.
  if (raw === null) return "mainframe";
  if (raw === "document") return "mainframe";
  return "subresource";
}

interface ProxyOptions {
  /** Called on rejection (for observability/tests); receives a reason. */
  onReject?: (reason: string) => void;
  /**
   * Exact allowed HTTPS asset origins for tunnelled (CONNECT) subresources,
   * e.g. from ACCESSIBILITY_ALLOWED_ASSET_ORIGINS. Parsed/normalized in the
   * constructor; never changes at runtime.
   */
  assetOrigins?: string[];
}

export class EgressProxy {
  private server: http.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private listening = false;
  private readonly rejects: string[] = [];
  /** Monotonic: incremented on EVERY refusal, independent of the bounded log. */
  private refusals = 0;
  /** One entry per refusal (its destination host, or null when unattributable). Bounded. */
  private readonly refusalHosts: (string | null)[] = [];
  private readonly assetOriginsSet: Set<string>;

  constructor(
    private readonly config: AppConfig,
    private readonly originCache: AllowedOriginsCache,
    private readonly opts: ProxyOptions = {},
  ) {
    this.assetOriginsSet = new Set((opts.assetOrigins ?? []).map((o) => normalizeAllowedOriginEntry(o)).filter((o): o is string => o !== null));
  }

  /**
   * Start binding 127.0.0.1 with a random ephemeral port. The forward-HTTP
   * path is handled by Node's HTTP parser (http.createServer): EVERY proxied
   * request (including keep-alive/pipelined re-requests on the same client
   * socket) is validated again in the request handler. CONNECT tunnels are
   * handled via the server's "connect" event. Never crashes on bad clients:
   * all request errors land in "clientError" and handlers are try-caught.
   */
  async start(): Promise<number> {
    if (this.server) throw new AppError("SCAN_FAILED", "Egress proxy already started.", "Restart the service.", false);
    const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
      void this.handleForward(req, res).catch(() => this.safeDestroy(req.socket));
    });
    server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
      // Attached synchronously, BEFORE any awaited work: once a CONNECT is
      // upgraded the HTTP server no longer handles this socket, so an unhandled
      // 'error' (e.g. ECONNRESET while DNS is pending) would crash the process.
      clientSocket.on("error", () => this.safeDestroy(clientSocket));
      this.handleConnect(req, clientSocket, head).catch(() => this.safeDestroy(clientSocket));
    });
    server.on("clientError", (err: Error, socket: net.Socket) => {
      this.rejectLine(`proxy bad client: ${err.message}`);
      if (!socket.destroyed) {
        try {
          // 403 keeps the engine-side "was anything refused" observability
          // consistent with the policy rejections.
          socket.write(HTTP_FORBIDDEN, () => socket.destroy());
          socket.on("error", () => socket.destroy());
        } catch {
          this.safeDestroy(socket);
        }
      }
    });
    server.on("connection", (socket: net.Socket) => this.track(socket));
    // Bounded header wait; total request duration additionally bounded.
    server.headersTimeout = HEADER_WAIT_TIMEOUT_MS;
    server.requestTimeout = 60_000;
    await new Promise<void>((resolve, reject) => {
      // Ephemeral random port, loopback only: unreachable by other hosts.
      server.listen(0, "127.0.0.1");
      server.once("listening", () => resolve());
      server.once("error", (err) => reject(err));
    });
    this.server = server;
    this.listening = true;
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new AppError("SCAN_FAILED", "Egress proxy failed to obtain a loopback port.", "Restart the service.", false);
    }
    return address.port;
  }

  get rejectLog(): readonly string[] {
    return this.rejects;
  }

  /**
   * Monotonic count of every refusal/rejection ever recorded. Unlike
   * `rejectLog` (bounded and de-duplicated by content by callers), this never
   * drops or merges entries: scanners compare the value before and after a
   * scan to detect ANY network refusal during it.
   */
  get totalRefusalCount(): number {
    return this.refusals;
  }

  /**
   * Destination host of each refusal since the monotonic count `since` (one
   * entry per refusal; null when no host was attributable). Returns null when
   * older entries were trimmed out of the bounded log: the caller must then
   * fall back to the raw count delta.
   */
  refusalHostsSince(since: number): (string | null)[] | null {
    const base = this.refusals - this.refusalHosts.length;
    if (since < base) return null;
    return this.refusalHosts.slice(since - base);
  }

  /** Exposed for the scanner: exact allowed asset origins in normalized form. */
  get allowedAssetOrigins(): Set<string> {
    return this.assetOriginsSet;
  }

  /** Public rejection hook (bounded log) used by the scanner route guard. */
  note(reason: string, host: string | null = null): void {
    this.rejectLine(reason, host);
  }

  private rejectLine(reason: string, host: string | null = null): void {
    this.refusals += 1;
    this.refusalHosts.push(host);
    if (this.refusalHosts.length > REFUSAL_HOST_LOG_CAP) this.refusalHosts.shift();
    this.rejects.push(reason);
    if (this.rejects.length > 500) this.rejects.shift();
    this.opts.onReject?.(reason);
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    if (this.sockets.size > 4_000) {
      // Hard cap: never let demo sockets accumulate unboundedly.
      for (const s of [...this.sockets].slice(0, 1_000)) this.safeDestroy(s);
    }
  }

  private safeDestroy(socket: net.Socket): void {
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }

  private respond(res: http.ServerResponse, status: number, reason: string, host: string | null = null): void {
    this.rejectLine(reason, host);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { connection: "close", "content-length": "0" });
    res.end();
  }

  /**
   * Destination policy by request kind. `tunnel` is used for EVERY CONNECT:
   * Chromium sends no reliable fetch metadata on CONNECT, so the proxy cannot
   * tell a top-level page from a subresource and must not guess from a header.
   * The strict tunnel policy admits exact main origins/hosts and exact asset
   * origins only. TLS is opaque here, so the proxy cannot see redirects or
   * top-level navigations; those are checked by the scanner's context route
   * guard and final-URL check instead (no universal per-redirect guarantee).
   */
  private destinationDecision(
    kind: "mainframe" | "subresource" | "tunnel",
    scheme: "http" | "https" | null,
    host: string,
    port: number,
  ): { allowed: boolean; allowLoopback: boolean } {
    if (kind === "tunnel") {
      // Strict tunnel policy: exact main origins or exact asset origins only
      // (never "any public HTTPS host"). Scheme may be ambiguous with custom
      // ports; both mappings are accepted against the exact origin entries.
      const ok =
        assertTunnelSubresourceAllowed(scheme ?? "https", host, port, this.config, this.originCache, this.assetOriginsSet) ||
        (scheme === null && assertTunnelSubresourceAllowed("http", host, port, this.config, this.originCache, this.assetOriginsSet));
      const allowLoopback =
        this.config.allowLocal &&
        ((isIpLiteral(host) && classifyIp(host) === "loopback") || (!isIpLiteral(host) && isLoopbackHostname(host)));
      return { allowed: ok, allowLoopback };
    }
    if (kind === "mainframe") {
      // Scheme may be ambiguous (CONNECT with a custom port): accept either
      // default mapping when an exact origin allowlist entry matches.
      const ok =
        assertMainFrameDestinationAllowed(scheme ?? "https", host, port, this.config, this.originCache) ||
        (scheme === null && assertMainFrameDestinationAllowed("http", host, port, this.config, this.originCache));
      if (!ok) return { allowed: false, allowLoopback: false };
      const loopback =
        (isIpLiteral(host) && classifyIp(host) === "loopback") ||
        (!isIpLiteral(host) && isLoopbackHostname(host));
      return { allowed: true, allowLoopback: loopback && this.config.allowLocal };
    }
    const ok = assertSubresourceDestinationAllowed(scheme, host, port, this.config, this.originCache, this.assetOriginsSet);
    const allowLoopback =
      this.config.allowLocal &&
      ((isIpLiteral(host) && classifyIp(host) === "loopback") || (!isIpLiteral(host) && isLoopbackHostname(host)));
    return { allowed: ok, allowLoopback };
  }

  /** Write a refusal to the client tunnel socket (no-op once the client is gone). */
  private refuseTunnel(socket: net.Socket, response: string): void {
    if (socket.destroyed) return;
    socket.write(response, () => this.safeDestroy(socket));
  }

  private async handleConnect(req: http.IncomingMessage, socket: net.Socket, initialHead: Buffer): Promise<void> {
    const rawTarget = req.url ?? "";
    const target = parseConnectTarget(rawTarget);
    if (target === null) {
      this.rejectLine(`malformed CONNECT target: ${rawTarget.slice(0, 128)}`);
      this.refuseTunnel(socket, HTTP_FORBIDDEN);
      return;
    }
    const host = normalizeHostname(target.host);
    // CONNECT is TLS unless the port is 80; custom ports rely on exact origin
    // allowlist entries (scheme ambiguity accepted against exact entries).
    const scheme: "http" | "https" | null = target.port === 443 ? "https" : target.port === 80 ? "http" : null;
    const decision = this.destinationDecision("tunnel", scheme, host, target.port);
    if (!decision.allowed) {
      this.rejectLine(`CONNECT destination not allowed: ${host}:${target.port}`, host);
      this.refuseTunnel(socket, HTTP_FORBIDDEN);
      return;
    }
    let pinned: string;
    try {
      pinned = (await resolvePinnedHost(host, { allowLoopback: decision.allowLoopback })).address;
    } catch (err) {
      const appErr = err as AppError;
      this.rejectLine(`CONNECT resolve rejected: ${appErr?.code ?? "error"} (${host})`, host);
      this.refuseTunnel(socket, appErr?.code === "TARGET_UNREACHABLE" ? HTTP_BAD_GATEWAY : HTTP_FORBIDDEN);
      return;
    }
    // The client may have reset while DNS was pending: never open an upstream
    // connection on behalf of a socket that is already gone.
    if (socket.destroyed) return;

    const upstream = this.connectUpstream(pinned, target.port);
    // Client reset/close at any later point (connect, stall, relay) tears the
    // upstream down too; the pipe teardown below covers the established case.
    socket.once("close", () => this.safeDestroy(upstream));
    let established = false;
    upstream.on("error", () => {
      if (!established) {
        this.rejectLine(`CONNECT upstream failure (${host}:${target.port})`, host);
        this.refuseTunnel(socket, HTTP_BAD_GATEWAY);
      }
    });
    if (!(await this.awaitConnect(upstream, socket, established))) {
      this.safeDestroy(socket);
      this.safeDestroy(upstream);
      return;
    }
    if (socket.destroyed) {
      this.safeDestroy(upstream);
      return;
    }
    established = true;
    socket.setTimeout(TUNNEL_IDLE_TIMEOUT_MS, () => {
      this.safeDestroy(socket);
      this.safeDestroy(upstream);
    });
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n", () => {
      // Forward any bytes that arrived before the tunnel completed; the
      // TLS ClientHello (or plain HTTP request after establishment).
      if (initialHead.length > 0) upstream.write(initialHead);
      socket.pipe(upstream);
      upstream.pipe(socket);
      const teardown = (): void => {
        this.safeDestroy(socket);
        this.safeDestroy(upstream);
      };
      socket.on("close", teardown);
      upstream.on("close", teardown);
      socket.on("error", teardown);
      upstream.on("error", teardown);
    });
  }

  private awaitConnect(upstream: net.Socket, client: net.Socket, alreadyEstablished: boolean): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (alreadyEstablished || upstream.readyState === "open") {
        resolve(true);
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const fail = (): void => {
        if (timer) clearTimeout(timer);
        resolve(false);
      };
      timer = setTimeout(() => {
        this.rejectLine("CONNECT upstream connect timeout");
        this.safeDestroy(client);
        this.safeDestroy(upstream);
        fail();
      }, UPSTREAM_CONNECT_TIMEOUT_MS);
      upstream.once("connect", () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      });
      upstream.once("close", () => {
        if (timer) clearTimeout(timer);
        resolve(false);
      });
      upstream.on("error", () => {
        if (timer) clearTimeout(timer);
        fail();
      });
    });
  }

  private connectUpstream(address: string, port: number): net.Socket {
    const upstream = net.connect({ host: address, port, family: address.includes(":") ? 6 : 4 });
    upstream.setNoDelay(true);
    this.track(upstream);
    return upstream;
  }

  /**
   * Per-request forward validation (Node HTTP parser): validated per request
   * even on keep-alive/pipelined client sockets. The engine also enforces
   * GET/HEAD only here (the Playwright context guard blocks mutations first;
   * this is the defense-in-depth at the socket boundary).
   */
  private async handleForward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method ?? "").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      this.respond(res, 403, `forward method not allowed: ${method}`);
      return;
    }
    const rawTarget = req.url ?? "";
    let url: URL;
    try {
      url = new URL(rawTarget);
    } catch {
      this.respond(res, 403, "non-absolute http proxy target");
      return;
    }
    if (url.protocol !== "http:") {
      this.respond(res, 403, `non-http forward target (${url.protocol})`);
      return;
    }
    if (url.username !== "" || url.password !== "") {
      this.respond(res, 403, "forward target with credentials");
      return;
    }
    const host = normalizeHostname(url.hostname);
    const port = effectivePort("http:", url.port);
    const fetchDest = req.headers["sec-fetch-dest"];
    const classification = classifyFetchDest(typeof fetchDest === "string" ? fetchDest.toLowerCase() : null);
    const decision = this.destinationDecision(classification, "http", host, port);
    if (!decision.allowed) {
      this.respond(res, 403, `forward destination not allowed: ${host}:${port}`, host);
      return;
    }
    let pinned: string;
    try {
      pinned = (await resolvePinnedHost(host, { allowLoopback: decision.allowLoopback })).address;
    } catch (err) {
      const appErr = err as AppError;
      const code = appErr?.code ?? "error";
      this.rejectLine(`forward resolve rejected: ${code} (${host})`, host);
      res.writeHead(code === "TARGET_UNREACHABLE" ? 502 : 403, { connection: "close" });
      res.end();
      return;
    }

    // Rewrite the absolute-form target to origin-form against the PINNED
    // address only. The Host header stays the ORIGINAL target hostname — it is
    // never reinterpreted from the socket peer — while the connection goes to
    // the verified public IP (DNS-rebinding control).
    const upstreamPath = `${url.pathname === "" ? "/" : url.pathname}${url.search}`;
    const upstreamHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP_HEADERS.has(name)) continue;
      if (value !== undefined) upstreamHeaders[name] = value;
    }
    upstreamHeaders["host"] = url.host; // checked target hostname (original, not pinned)
    const upstream = http.request({
      host: pinned,
      port,
      path: upstreamPath,
      method,
      headers: upstreamHeaders,
      agent: false,
    });

    let failed = false;
    const ab = (): void => {
      failed = true;
      this.destroyUpstream(upstream);
      res.destroy();
    };
    req.on("aborted", ab);
    res.on("close", ab);
    upstream.on("timeout", ab);
    upstream.on("error", (e) => {
      if (failed) return;
      failed = true;
      this.rejectLine(`forward upstream failure (${host}:${port}): ${e.message}`, host);
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(502, { connection: "close" });
        res.end();
      }
    });
    upstream.on("response", (upstreamRes) => {
      if (failed) {
        upstreamRes.destroy();
        return;
      }
      // Response is untrusted content; relaying is streaming only. Hop-by-hop
      // response headers are not relayed.
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(name)) continue;
        if (value !== undefined) headers[name] = value;
      }
      try {
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
      } catch {
        res.destroy();
        upstreamRes.destroy();
        return;
      }
      upstreamRes.on("aborted", () => res.destroy());
      upstreamRes.pipe(res);
    });
    // Stream any request body chunks (GET/HEAD bodies are rare and tiny; the
    // request itself was already validated).
    req.pipe(upstream);
  }

  private destroyUpstream(upstream: http.ClientRequest): void {
    try {
      upstream.destroy();
    } catch {
      // ignore
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = false;
    for (const s of this.sockets) this.safeDestroy(s);
    this.sockets.clear();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.unref();
      server.close(() => resolve());
      // Force-close lingering connections (belt and braces; runtime Node >=18).
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      setTimeout(resolve, 250).unref?.();
    });
  }

  /** Alias for stop() (stable public API). */
  async close(): Promise<void> {
    await this.stop();
  }

  get isListening(): boolean {
    return this.listening;
  }
}

// Re-export ScanEngine type so callers importing network don't need contracts.
export type { ScanEngine };
