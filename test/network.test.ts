/**
 * Network security tests (engine worker): IP classification, CONNECT parsing,
 * traversal/credential/allowlist validation, DNS pinning decisions, and egress
 * proxy behavior over real sockets (no browser needed).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import dns from "node:dns";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertMainFrameDestinationAllowed,
  assertSubresourceDestinationAllowed,
  assertTunnelSubresourceAllowed,
  buildOriginsCache,
  classifyIp,
  EgressProxy,
  hasUrlTraversal,
  isIpLiteral,
  normalizeHostname,
  parseAllowedAssetOrigins,
  parseConnectTarget,
  resolvePinnedHost,
  validateTargetUrl,
  type AllowedOriginsCache,
} from "../src/network.js";
import { parseConfig, type AppConfig as ParsedAppConfig } from "../src/config.js";
import { copyFixtures, startFixtureServer, type FixtureServer } from "./helpers/fixtureServer.js";

/** Assert a sync function throws an AppError with the exact code. */
function assertAppError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected function to throw AppError with code ${code}`);
}

const FIXTURE_SOURCE = path.resolve(import.meta.dirname, "fixtures");

type TestConfig = ParsedAppConfig;

function cfg(overrides: { allowLocal?: boolean; allowedHosts?: string[]; allowedOrigins?: string[] } = {}): TestConfig {
  return parseConfig({
    ACCESSIBILITY_PROJECT_ROOT: process.cwd(),
    ACCESSIBILITY_ALLOW_LOCAL: overrides.allowLocal ? "true" : "false",
    ACCESSIBILITY_ALLOWED_ORIGINS: (overrides.allowedOrigins ?? []).join(","),
    ACCESSIBILITY_ALLOWED_HOSTS: (overrides.allowedHosts ?? []).join(","),
    PORT: "8080",
  });
}

function cache(c: TestConfig, overrides: { origins?: string[]; hosts?: string[] } = {}): AllowedOriginsCache {
  return buildOriginsCache({
    ...c,
    allowedOrigins: overrides.origins ?? [],
    allowedHosts: overrides.hosts ?? [],
  });
}

describe("classifyIp: private/reserved/metadata/unusable ranges (IPv4 + IPv6 + v4-mapped)", () => {
  const publicCases = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "172.15.255.255", "172.32.0.1", "::ffff:8.8.8.8"];
  const loopbackCases = ["127.0.0.1", "127.8.8.8", "::1", "::ffff:127.0.0.1"];
  const restrictedCases = [
    "10.1.2.3",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254",
    "169.254.1.1",
    "224.0.0.5",
    "255.255.255.255",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.2.99",
    "203.0.113.44",
    "fe80::1",
    "fc00::1",
    "fd00::1",
    "ff02::1",
    "::",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
  ];

  for (const ip of publicCases) {
    it(`classifies ${ip} as public`, () => {
      expect(classifyIp(ip)).toBe("public");
    });
  }
  for (const ip of loopbackCases) {
    it(`classifies ${ip} as loopback`, () => {
      expect(classifyIp(ip)).toBe("loopback");
    });
  }
  for (const ip of restrictedCases) {
    it(`classifies ${ip} as restricted`, () => {
      expect(classifyIp(ip)).toBe("restricted");
    });
  }
});

describe("hostname helpers", () => {
  it("normalizes IPv6 brackets, case and trailing dots", () => {
    expect(normalizeHostname("[::1]")).toBe("::1");
    expect(normalizeHostname("INDIA.GOV.IN.")).toBe("india.gov.in");
    expect(isIpLiteral("8.8.8.8")).toBe(true);
    expect(isIpLiteral("india.gov.in")).toBe(false);
  });
});

describe("parseConnectTarget: robust CONNECT host:port parsing", () => {
  it("parses host:port and bracketed IPv6", () => {
    expect(parseConnectTarget("127.0.0.1:4173")).toEqual({ host: "127.0.0.1", port: 4173 });
    expect(parseConnectTarget("[::1]:443")).toEqual({ host: "::1", port: 443 });
    expect(parseConnectTarget("india.gov.in:443")).toEqual({ host: "india.gov.in", port: 443 });
  });

  it("rejects bracket-less IPv6, missing, out-of-range and junk-suffixed ports", () => {
    expect(parseConnectTarget("::1:443")).toBeNull();
    expect(parseConnectTarget("india.gov.in")).toBeNull();
    expect(parseConnectTarget("india.gov.in:99999")).toBeNull();
    expect(parseConnectTarget("india.gov.in:0")).toBeNull();
    expect(parseConnectTarget("[bad:443")).toBeNull();
    expect(parseConnectTarget("")).toBeNull();
    expect(parseConnectTarget("1.2.3.4:443junk")).toBeNull();
    expect(parseConnectTarget("1.2.3.4:443 junk")).toBeNull();
  });
});

describe("hasUrlTraversal", () => {
  it("rejects raw and encoded dot-segments; allows plain paths", () => {
    expect(hasUrlTraversal("http://127.0.0.1/a/../b")).toBe(true);
    expect(hasUrlTraversal("http://127.0.0.1/a/%2e%2e/secret")).toBe(true);
    expect(hasUrlTraversal("http://127.0.0.1/a/b?query=..")).toBe(false);
    expect(hasUrlTraversal("http://127.0.0.1/a/b")).toBe(false);
  });
});

describe("validateTargetUrl: allowlist + structural safety", () => {
  it("accepts exact allowlisted loopback origins with allowLocal (LOCAL TESTS ONLY)", () => {
    const c = cfg({ allowLocal: true, allowedOrigins: ["http://127.0.0.1:4173"] });
    const v = validateTargetUrl("http://127.0.0.1:4173/fixtures/registration.html", c);
    expect(v.hostname).toBe("127.0.0.1");
    expect(v.port).toBe(4173);
    expect(v.origin).toBe("http://127.0.0.1:4173");
  });

  it("rejects loopback origins when allowLocal=false even if listed", () => {
    const c = cfg({ allowLocal: false, allowedOrigins: ["http://127.0.0.1:4173"] });
    expect(() => validateTargetUrl("http://127.0.0.1:4173/", c)).toThrow();
  });

  it("accepts allowlisted host with default port only; rejects custom ports", () => {
    const c = cfg({ allowedHosts: ["india.gov.in"] });
    expect(validateTargetUrl("https://india.gov.in/some/page", c).port).toBe(443);
    assertAppError(() => validateTargetUrl("https://india.gov.in:8443/", c), "TARGET_NOT_ALLOWED");
    expect(validateTargetUrl("http://india.gov.in/", c).port).toBe(80);
  });

  it("exact matching only: subdomains, suffixes and confusables are rejected", () => {
    const c = cfg({ allowedHosts: ["india.gov.in"] });
    for (const bad of [
      "https://sub.india.gov.in/",
      "https://india.gov.in.evil.example/",
      "https://notindia.gov.in/",
    ]) {
      assertAppError(() => validateTargetUrl(bad, c), "TARGET_NOT_ALLOWED");
    }
  });

  it("rejects credentials in URL", () => {
    const c = cfg({ allowedHosts: ["india.gov.in"] });
    assertAppError(() => validateTargetUrl("https://user:pass@india.gov.in/", c), "TARGET_NOT_ALLOWED");
  });

  it("rejects traversal URLs before they can be normalized away", () => {
    const c = cfg({ allowLocal: true, allowedOrigins: ["http://127.0.0.1:4173"] });
    assertAppError(() => validateTargetUrl("http://127.0.0.1:4173/a/../secret", c), "INVALID_ARGUMENT");
  });

  it("rejects unsupported schemes", () => {
    const c = cfg({ allowLocal: true, allowedOrigins: [] });
    expect(() => validateTargetUrl("file:///etc/passwd", c)).toThrow();
    expect(() => validateTargetUrl("ftp://example.com/x", c)).toThrow();
  });
});

describe("resolvePinnedHost: DNS pinning policy", () => {
  it("resolves loopback only when allowLoopback is granted", async () => {
    const ok = await resolvePinnedHost("localhost", { allowLoopback: true });
    expect(["127.0.0.1", "::1"]).toContain(ok.address);
    await expect(resolvePinnedHost("localhost", { allowLoopback: false })).rejects.toMatchObject({
      code: "TARGET_NOT_ALLOWED",
    });
  });

  it("returns TARGET_UNREACHABLE for hosts that cannot be resolved", async () => {
    await expect(resolvePinnedHost("this-host-does-not-exist.invalid", { allowLoopback: false })).rejects.toMatchObject({
      code: "TARGET_UNREACHABLE",
    });
  });

  it("pins direct IP literals without DNS; rejects private/metadata literals", async () => {
    expect((await resolvePinnedHost("8.8.8.8", { allowLoopback: false })).address).toBe("8.8.8.8");
    await expect(resolvePinnedHost("10.0.0.99", { allowLoopback: false })).rejects.toMatchObject({ code: "TARGET_NOT_ALLOWED" });
    await expect(resolvePinnedHost("169.254.169.254", { allowLoopback: false })).rejects.toMatchObject({
      code: "TARGET_NOT_ALLOWED",
    });
  });
});

describe("main-frame destination policy (pure)", () => {
  const local = cfg({ allowLocal: true, allowedOrigins: ["http://127.0.0.1:4173"] });
  const publicHost = cfg({ allowedHosts: ["india.gov.in"] });
  const localCache = cache(local, { origins: local.allowedOrigins });
  const publicCache = cache(publicHost, { hosts: publicHost.allowedHosts });

  it("exact allowlisted loopback origin requires allowLocal", () => {
    expect(assertMainFrameDestinationAllowed("http", "127.0.0.1", 4173, local, localCache)).toBe(true);
    expect(assertMainFrameDestinationAllowed("http", "127.0.0.1", 4174, local, localCache)).toBe(false);
    const noLocal = cfg({ allowLocal: false, allowedOrigins: ["http://127.0.0.1:4173"] });
    expect(assertMainFrameDestinationAllowed("http", "127.0.0.1", 4173, noLocal, cache(noLocal, { origins: noLocal.allowedOrigins }))).toBe(false);
  });

  it("public allowlisted host with default ports only (80/443)", () => {
    expect(assertMainFrameDestinationAllowed("https", "india.gov.in", 443, publicHost, publicCache)).toBe(true);
    expect(assertMainFrameDestinationAllowed("https", "india.gov.in", 8443, publicHost, publicCache)).toBe(false);
    expect(assertMainFrameDestinationAllowed("http", "sub.india.gov.in", 80, publicHost, publicCache)).toBe(false);
    expect(assertMainFrameDestinationAllowed("https", "10.0.0.9", 443, publicHost, publicCache)).toBe(false);
  });

  it("rejects restricted IP literals outright", () => {
    expect(assertMainFrameDestinationAllowed("https", "169.254.169.254", 443, local, localCache)).toBe(false);
    expect(assertMainFrameDestinationAllowed("http", "fd00::5", 80, local, localCache)).toBe(false);
  });
});

describe("asset-origin allowlist parsing (engine-owned env, no root config change)", () => {
  it("parses comma-separated exact origins and normalizes entries", () => {
    const parsed = parseAllowedAssetOrigins({
      ACCESSIBILITY_ALLOWED_ASSET_ORIGINS: "https://fonts.gstatic.com:443, https://cdn.example.org ,  ,",
    });
    expect([...parsed.origins]).toContain("https://fonts.gstatic.com:443");
    expect([...parsed.origins]).toContain("https://cdn.example.org:443");
    // raw echoes the non-empty configured entries (empties are dropped).
    expect(parsed.raw).toHaveLength(2);
  });

  it("rejects non-exact entries (wildcards, bare hosts, wrong scheme)", () => {
    const parsed = parseAllowedAssetOrigins({
      ACCESSIBILITY_ALLOWED_ASSET_ORIGINS: "*.example.org, example.org, ftp://x.example.com:21",
    });
    expect(parsed.origins.size).toBe(0);
    // raw is echoed for transparency (what was configured).
    expect(parsed.raw).toHaveLength(3);
  });

  it("empty/unset env yields an empty set", () => {
    expect(parseAllowedAssetOrigins({}).origins.size).toBe(0);
  });
});

describe("tunnelled (CONNECT) subresource policy (pure)", () => {
  const local = cfg({ allowLocal: true, allowedOrigins: ["http://127.0.0.1:4173"] });
  const localCache = cache(local, { origins: local.allowedOrigins });
  const loopbackFixtureOrigin = (port: number): string => `http://127.0.0.1:${port}`;

  it("allows only exact main or asset origins over HTTPS; other public hosts refused", () => {
    expect(assertTunnelSubresourceAllowed("https", "fonts.gstatic.com", 443, local, localCache, new Set(["https://fonts.gstatic.com:443"]))).toBe(true);
    expect(assertTunnelSubresourceAllowed("https", "example.org", 443, local, localCache, new Set())).toBe(false);
    expect(assertTunnelSubresourceAllowed("https", "india.gov.in", 443, cfg({ allowedHosts: ["india.gov.in"] }), cache(cfg({ allowedHosts: ["india.gov.in"] }), { hosts: ["india.gov.in"] }), new Set())).toBe(true);
  });

  it("loopback tunneled subresources require allowLocal and an exact entry (main or asset)", () => {
    const fixturePort = 4173;
    expect(
      assertTunnelSubresourceAllowed("http", "127.0.0.1", fixturePort, local, cache(local, { origins: [] }), new Set([loopbackFixtureOrigin(fixturePort)])),
    ).toBe(true);
    expect(
      assertTunnelSubresourceAllowed("http", "127.0.0.1", 4173, local, localCache, new Set()),
    ).toBe(true);
    const noLocal = cfg({ allowLocal: false, allowedOrigins: [] });
    expect(
      assertTunnelSubresourceAllowed("http", "127.0.0.1", fixturePort, noLocal, cache(noLocal), new Set([loopbackFixtureOrigin(fixturePort)])),
    ).toBe(false);
  });

  it("restricted IP literals are refused even when listed as asset origins", () => {
    expect(
      assertTunnelSubresourceAllowed("https", "169.254.169.254", 443, local, localCache, new Set(["https://169.254.169.254:443"])),
    ).toBe(false);
  });
});

describe("subresource destination policy (pure)", () => {
  const local = cfg({ allowLocal: true, allowedOrigins: ["http://127.0.0.1:4173"] });
  const localCache = cache(local, { origins: local.allowedOrigins });

  it("allows plain-HTTP public assets on port 80; HTTPS requires exact main/asset origin", () => {
    expect(assertSubresourceDestinationAllowed("http", "india.gov.in", 80, local, localCache)).toBe(true);
    expect(assertSubresourceDestinationAllowed("https", "example.org", 443, local, localCache)).toBe(false);
    expect(
      assertSubresourceDestinationAllowed("https", "example.org", 443, local, localCache, new Set(["https://example.org:443"])),
    ).toBe(true);
    expect(assertSubresourceDestinationAllowed(null, "example.org", 8443, local, localCache)).toBe(false);
    const custom = cfg({ allowLocal: false, allowedOrigins: ["https://example.org:8443"] });
    expect(
      assertSubresourceDestinationAllowed("https", "example.org", 8443, custom, cache(custom, { origins: custom.allowedOrigins })),
    ).toBe(true);
  });

  it("blocks loopback subresources unless the exact loopback origin is allowlisted with allowLocal", () => {
    expect(assertSubresourceDestinationAllowed("http", "127.0.0.1", 4173, local, localCache)).toBe(true);
    expect(assertSubresourceDestinationAllowed("http", "127.0.0.1", 4189, local, localCache)).toBe(false);
    const noLocal = cfg({ allowLocal: false, allowedOrigins: ["http://127.0.0.1:4173"] });
    expect(assertSubresourceDestinationAllowed("http", "127.0.0.1", 4173, noLocal, cache(noLocal, { origins: noLocal.allowedOrigins }))).toBe(false);
    expect(assertSubresourceDestinationAllowed("http", "10.0.0.5", 80, local, localCache)).toBe(false);
  });
});

describe("EgressProxy over real sockets", () => {
  let server: FixtureServer;
  let workDir: string;
  let proxy: EgressProxy;
  let proxyPort: number;
  let config: TestConfig;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(process.env["TMPDIR"] ?? "/tmp", "glorp-net-"));
    await copyFixtures(FIXTURE_SOURCE, workDir);
    server = await startFixtureServer(workDir);
    config = parseConfig({
      ACCESSIBILITY_PROJECT_ROOT: process.cwd(),
      ACCESSIBILITY_ALLOW_LOCAL: "true",
      ACCESSIBILITY_ALLOWED_ORIGINS: server.origin,
      PORT: "8080",
    });
    proxy = new EgressProxy(config, buildOriginsCache(config));
    proxyPort = await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await server.close();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  interface ForwardOptions {
    timeoutMs?: number;
    /** Resolve ~100ms after the first response bytes instead of on close. */
    earlyResolve?: boolean;
    host?: string;
  }

  function forwardRaw(request: string, options: ForwardOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, options.host ?? "127.0.0.1");
      let data = "";
      let settled = false;
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(data || "(timeout)");
      }, timeoutMs);
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString("latin1");
        if (options.earlyResolve && data.length > 0 && !settled) {
          settled = true;
          // Give in-flight chunks a brief window to coalesce, then report.
          setTimeout(() => {
            clearTimeout(timer);
            socket.destroy();
            resolve(data);
          }, 100);
        }
      });
      socket.on("close", () => {
        if (settled) return;
        clearTimeout(timer);
        resolve(data);
      });
      socket.on("error", () => {
        if (settled) return;
        clearTimeout(timer);
        resolve(data || "(socket error)");
      });
      // Browser-like: keep the connection open (no half-close) after sending.
      socket.write(request);
    });
  }

  it("forwards HTTP to the allowlisted loopback fixture via absolute-form request (browser-shaped)", async () => {
    const response = await forwardRaw(
      [
        `GET http://127.0.0.1:${server.port}/fixtures/help.html HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        "Sec-Fetch-Dest: document",
        "",
        "",
      ].join("\r\n"),
      { earlyResolve: true },
    );
    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain("Registration Help");
  });

  it("rejects main-frame destinations outside the allowlist with 403", async () => {
    const response = await forwardRaw(
      ["GET http://198.51.100.7/some/path HTTP/1.1", "Host: 198.51.100.7", "Sec-Fetch-Dest: document", "", ""].join("\r\n"),
    );
    expect(response).toContain("403");
  });

  it("rejects metadata and private IP destinations outright with 403", async () => {
    for (const host of ["169.254.169.254", "10.1.1.1"]) {
      const response = await forwardRaw(
        [`GET http://${host}/latest/meta-data HTTP/1.1`, `Host: ${host}`, "Sec-Fetch-Dest: script", "", ""].join("\r\n"),
      );
      expect(response).toContain("403");
    }
  });

  it("rejects malformed CONNECT targets", async () => {
    const response = await forwardRaw(["CONNECT [::1] HTTP/1.1", "Host: [::1]", "", ""].join("\r\n"));
    expect(response).toContain("403");
  });

  it("CONNECT to allowlisted loopback proceeds with 200", async () => {
    // Browser-shaped CONNECT: no Sec-Fetch-Dest (Chromium does not send it).
    const response = await forwardRaw(
      [`CONNECT 127.0.0.1:${server.port} HTTP/1.1`, `Host: 127.0.0.1:${server.port}`, "", ""].join("\r\n"),
      { earlyResolve: true, timeoutMs: 3_000 },
    );
    expect(response).toContain("200 Connection established");
  });

  it("CONNECT to private/metadata addresses is forbidden", async () => {
    const response = await forwardRaw(["CONNECT 169.254.169.254:443 HTTP/1.1", "Host: 169.254.169.254", "", ""].join("\r\n"));
    expect(response).toContain("403");
  });

  it("oversized headers are refused without forwarding (403/431)", async () => {
    const big = "A".repeat(40_000);
    const response = await forwardRaw([`GET http://127.0.0.1:${server.port}/x HTTP/1.1`, `X-Big: ${big}`, "", ""].join("\r\n"));
    expect(response).toMatch(/403|431/);
  });

  it("origin-form proxy requests (non-absolute) are rejected", async () => {
    const response = await forwardRaw([`GET /fixtures/help.html HTTP/1.1`, `Host: 127.0.0.1:${server.port}`, "", ""].join("\r\n"));
    expect(response).toContain("403");
  });

  it("per-request validation applies to pipelined/keep-alive requests on the same socket (second request is re-validated)", async () => {
    // Two requests over one connection: the first allowed, the second
    // (different destination) forbidden. The raw pipe approach of the old
    // implementation would have forwarded the second blindly.
    const both = [
      `GET http://127.0.0.1:${server.port}/fixtures/help.html HTTP/1.1`,
      `Host: 127.0.0.1:${server.port}`,
      "Sec-Fetch-Dest: document",
      "",
      `GET http://198.51.100.7/nope HTTP/1.1`,
      `Host: 198.51.100.7`,
      `Sec-Fetch-Dest: document`,
      "",
      "",
    ].join("\r\n");
    const response = await forwardRaw(both, { timeoutMs: 8_000 });
    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain("403 Forbidden");
  });
});

/**
 * Raw one-shot exchange with the proxy. With `firstChunk`, resolves on the first
 * response bytes (used for CONNECT, whose tunnel stays open after 200).
 */
function rawExchange(port: number, payload: string, options: { firstChunk?: boolean; timeoutMs?: number } = {}): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve(data || "(no response)");
    };
    timer = setTimeout(finish, options.timeoutMs ?? 3_000);
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (options.firstChunk) finish();
    });
    socket.on("close", () => {
      if (timer) clearTimeout(timer);
      resolve(data || "(closed)");
    });
    socket.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve(data || "(socket error)");
    });
    socket.write(payload);
  });
}

/** Browser-shaped CONNECT: Chromium sends no Sec-Fetch-Dest on CONNECT. */
function connectRequest(target: string): string {
  return [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, "", ""].join("\r\n");
}

describe("CONNECT policy: strict tunnel policy for every CONNECT (no Sec-Fetch-Dest branch)", () => {
  let server: FixtureServer;
  let workDir: string;
  let localProxy: EgressProxy;
  let localPort: number;
  let strictProxy: EgressProxy;
  let strictPort: number;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(process.env["TMPDIR"] ?? "/tmp", "glorp-net5-"));
    await copyFixtures(FIXTURE_SOURCE, workDir);
    server = await startFixtureServer(workDir);
    // Local proxy: loopback allowed (tests only); the fixture origin is an
    // exact ASSET origin and there are NO main allowlist entries.
    const localConfig = parseConfig({
      ACCESSIBILITY_PROJECT_ROOT: process.cwd(),
      ACCESSIBILITY_ALLOW_LOCAL: "true",
      ACCESSIBILITY_ALLOWED_ORIGINS: "",
      PORT: "8080",
    });
    localProxy = new EgressProxy(localConfig, buildOriginsCache(localConfig), { assetOrigins: [server.origin] });
    localPort = await localProxy.start();
    // Strict proxy: allowLocal OFF. Explicit asset origins that would resolve to
    // private/loopback space or are restricted literals must still be refused.
    const strictConfig = parseConfig({
      ACCESSIBILITY_PROJECT_ROOT: process.cwd(),
      ACCESSIBILITY_ALLOW_LOCAL: "false",
      ACCESSIBILITY_ALLOWED_ORIGINS: "",
      PORT: "8080",
    });
    strictProxy = new EgressProxy(strictConfig, buildOriginsCache(strictConfig), {
      assetOrigins: [server.origin, "https://localhost:443", "https://169.254.169.254:443"],
    });
    strictPort = await strictProxy.start();
  });

  afterAll(async () => {
    await localProxy.stop();
    await strictProxy.stop();
    await server.close();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("CONNECT to an exact asset origin without Sec-Fetch-Dest is tunnelled (200, not 403)", async () => {
    const response = await rawExchange(localPort, connectRequest(`127.0.0.1:${server.port}`), { firstChunk: true });
    expect(response).toContain("200 Connection established");
  });

  it("the same asset CONNECT is judged identically when a Sec-Fetch-Dest header is present", async () => {
    const withDocumentHeader = [
      `CONNECT 127.0.0.1:${server.port} HTTP/1.1`,
      `Host: 127.0.0.1:${server.port}`,
      "Sec-Fetch-Dest: document",
      "",
      "",
    ].join("\r\n");
    const response = await rawExchange(localPort, withDocumentHeader, { firstChunk: true });
    expect(response).toContain("200 Connection established");
  });

  it("a non-allowlisted public CONNECT is refused with or without Sec-Fetch-Dest (no public fallback)", async () => {
    expect(await rawExchange(localPort, connectRequest("example.org:443"), { firstChunk: true })).toContain("403");
    const withHeader = ["CONNECT example.org:443 HTTP/1.1", "Host: example.org:443", "Sec-Fetch-Dest: document", "", ""].join("\r\n");
    expect(await rawExchange(localPort, withHeader, { firstChunk: true })).toContain("403");
  });

  it("an explicit asset origin that resolves to loopback is refused when allowLocal is off (private DNS denied)", async () => {
    // `localhost` is on the explicit asset list, yet resolves to loopback.
    const response = await rawExchange(strictPort, connectRequest("localhost:443"), { firstChunk: true });
    expect(response).toContain("403");
  });

  it("an explicit asset origin that is a restricted IP literal is refused", async () => {
    const response = await rawExchange(strictPort, connectRequest("169.254.169.254:443"), { firstChunk: true });
    expect(response).toContain("403");
  });

  it("a loopback asset origin is refused when allowLocal is off (even though listed)", async () => {
    const response = await rawExchange(strictPort, connectRequest(`127.0.0.1:${server.port}`), { firstChunk: true });
    expect(response).toContain("403");
  });
});

describe("EgressProxy client lifecycle: resets during DNS and upstream stalls", () => {
  const config = parseConfig({
    ACCESSIBILITY_PROJECT_ROOT: process.cwd(),
    ACCESSIBILITY_ALLOW_LOCAL: "true",
    ACCESSIBILITY_ALLOWED_ORIGINS: "",
    PORT: "8080",
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a client reset while DNS is pending opens no upstream connection and the proxy stays alive", async () => {
    let resolveLookup: ((records: dns.LookupAddress[]) => void) | undefined;
    const lookupSpy = vi
      .spyOn(dns.promises, "lookup")
      .mockImplementation((() =>
        new Promise<dns.LookupAddress[]>((resolve) => {
          resolveLookup = resolve;
        })) as unknown as typeof dns.promises.lookup);
    const connectSpy = vi.spyOn(net, "connect");
    const proxy = new EgressProxy(config, buildOriginsCache(config), { assetOrigins: ["https://stall.example.org:443"] });
    const port = await proxy.start();
    try {
      const client = net.connect(port, "127.0.0.1");
      client.on("error", () => undefined);
      client.write(connectRequest("stall.example.org:443"));
      await vi.waitFor(() => expect(lookupSpy).toHaveBeenCalled());
      // Reset (RST) while the proxy is still waiting on DNS.
      client.resetAndDestroy();
      await new Promise((r) => setTimeout(r, 200));
      // DNS now answers with a public address; the proxy must NOT dial it.
      resolveLookup?.([{ address: "93.184.216.34", family: 4 }]);
      await new Promise((r) => setTimeout(r, 300));
      const dialedPinned = connectSpy.mock.calls.some((call) => JSON.stringify(call[0]).includes("93.184.216.34"));
      expect(dialedPinned).toBe(false);
      // The proxy process/listener is still alive and still enforcing policy.
      const probe = await rawExchange(port, "GET http://198.51.100.7/ HTTP/1.1\r\nHost: 198.51.100.7\r\n\r\n");
      expect(probe).toContain("403");
    } finally {
      resolveLookup?.([{ address: "93.184.216.34", family: 4 }]);
      await proxy.stop();
    }
  });

  it("a client reset during an upstream stall closes the upstream socket and the proxy stays alive", async () => {
    // Upstream accepts the TCP connection but never sends anything.
    let upstreamClosed = false;
    const stall = net.createServer((sock) => {
      sock.on("error", () => undefined);
      sock.on("close", () => {
        upstreamClosed = true;
      });
    });
    await new Promise<void>((resolve) => stall.listen(0, "127.0.0.1", () => resolve()));
    const stallPort = (stall.address() as net.AddressInfo).port;
    const proxy = new EgressProxy(config, buildOriginsCache(config), { assetOrigins: [`http://127.0.0.1:${stallPort}`] });
    const port = await proxy.start();
    try {
      const established = await rawExchange(port, connectRequest(`127.0.0.1:${stallPort}`), { firstChunk: true });
      expect(established).toContain("200 Connection established");
      // Client resets mid-stall: the upstream must be torn down as well.
      const client = net.connect(port, "127.0.0.1");
      client.on("error", () => undefined);
      client.write(connectRequest(`127.0.0.1:${stallPort}`));
      await vi.waitFor(() => expect(stall.listening).toBe(true));
      await new Promise((r) => setTimeout(r, 200));
      client.resetAndDestroy();
      await vi.waitFor(() => expect(upstreamClosed).toBe(true), { timeout: 5_000 });
      const probe = await rawExchange(port, "GET http://198.51.100.7/ HTTP/1.1\r\nHost: 198.51.100.7\r\n\r\n");
      expect(probe).toContain("403");
    } finally {
      await proxy.stop();
      await new Promise<void>((resolve) => stall.close(() => resolve()));
    }
  });
});

describe("EgressProxy refusal accounting (monotonic, attributable)", () => {
  it("counts every refusal monotonically and attributes each to its host", async () => {
    const config = parseConfig({ ACCESSIBILITY_PROJECT_ROOT: process.cwd(), ACCESSIBILITY_ALLOWED_ORIGINS: "", PORT: "8080" });
    const proxy = new EgressProxy(config, buildOriginsCache(config));
    const before = proxy.totalRefusalCount;
    proxy.note("refusal one", "assets.example.net");
    proxy.note("refusal two (same text)", "assets.example.net");
    proxy.note("refusal three, unattributed");
    expect(proxy.totalRefusalCount - before).toBe(3);
    expect(proxy.refusalHostsSince(before)).toEqual(["assets.example.net", "assets.example.net", null]);
    // Only refusals after the snapshot are returned.
    expect(proxy.refusalHostsSince(before + 2)).toEqual([null]);
  });

  it("reports null (caller falls back to the raw count) once older entries were trimmed", async () => {
    const config = parseConfig({ ACCESSIBILITY_PROJECT_ROOT: process.cwd(), ACCESSIBILITY_ALLOWED_ORIGINS: "", PORT: "8080" });
    const proxy = new EgressProxy(config, buildOriginsCache(config));
    const before = proxy.totalRefusalCount;
    for (let i = 0; i < 5_100; i += 1) proxy.note(`bulk ${i}`, "bulk.example.net");
    expect(proxy.totalRefusalCount - before).toBe(5_100);
    expect(proxy.refusalHostsSince(before)).toBeNull();
    expect(proxy.refusalHostsSince(proxy.totalRefusalCount - 10)).toHaveLength(10);
  });
});

describe("EgressProxy lifecycle", () => {
  it("binds loopback only on an ephemeral port and refuses connections after stop", async () => {
    const workDir = await fs.mkdtemp(path.join(process.env["TMPDIR"] ?? "/tmp", "glorp-net2-"));
    await copyFixtures(FIXTURE_SOURCE, workDir);
    const html = await startFixtureServer(workDir);
    const config = parseConfig({
      ACCESSIBILITY_PROJECT_ROOT: process.cwd(),
      ACCESSIBILITY_ALLOW_LOCAL: "true",
      ACCESSIBILITY_ALLOWED_ORIGINS: html.origin,
      PORT: "8080",
    });
    const proxy = new EgressProxy(config, buildOriginsCache(config));
    const port = await proxy.start();
    expect(port).toBeGreaterThan(0);
    expect(proxy.isListening).toBe(true);

    // The proxy说不 reachable from anything that is not loopback: bound to 127.0.0.1.
    const probeResult = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => resolve("open"));
      s.on("error", () => resolve("failed"));
      setTimeout(() => {
        s.destroy();
        resolve("timeout");
      }, 2_000);
    });
    expect(probeResult).toBe("open");

    await proxy.stop();
    expect(proxy.isListening).toBe(false);
    const after = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => {
        s.destroy();
        resolve("still-open");
      });
      s.on("error", () => resolve("failed"));
      setTimeout(() => {
        s.destroy();
        resolve("timeout");
      }, 2_000);
    });
    expect(["failed", "timeout"]).toContain(after);

    await html.close();
    await fs.rm(workDir, { recursive: true, force: true });
  });
});
