/**
 * Server-level tests: CORS ordering/policy, CSP routing, no-store caching,
 * fixture allowlist + alias, strict bodies and rate caps. Fake engine only
 * (no browser); real HTTP on an ephemeral loopback port.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildExpressApp, startServer } from "../src/server.js";
import { createService } from "../src/service.js";
import type { AppConfig } from "../src/config.js";
import { DEFAULT_ALLOWED_HOSTS } from "../src/config.js";
import { FakeEngine, InMemoryStore, fakeCompareRuns, finding, makeStored } from "./fakes.js";

const FIXTURES_DIR = new URL("../test/fixtures/", import.meta.url).pathname;
let server: http.Server;
let base: string;

function configFor(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    projectRoot: process.cwd(),
    reportDir: "/tmp/opencode/server-test-runs",
    bucket: undefined,
    allowedOrigins: [],
    allowedHosts: [...DEFAULT_ALLOWED_HOSTS],
    allowLocal: true,
    publicBaseUrl: "https://demo.example",
    port: 0,
    host: "127.0.0.1",
    browserExecutable: undefined,
    ttlMs: 86_400_000,
    scanTimeoutMs: 45_000,
    maxStoredBytes: 10 * 1024 * 1024,
    maxFindings: 100,
    readinessSelector: undefined,
    rateLimitPerIp: 1000,
    rateLimitGlobal: 1000,
    rateLimitWindowMs: 60_000,
    trustProxy: false,
    corsOrigins: [],
    webDistDir: "/tmp/opencode/nonexistent-web-dist",
    fixturesDir: FIXTURES_DIR,
    ...overrides,
  };
}

function makeApp(config: AppConfig) {
  const engine = new FakeEngine([() => makeStored({ url: "https://india.gov.in/", findings: [finding({ rule_id: "label", targets: ["#f"] })] })]);
  const service = createService({ engine, store: new InMemoryStore(), compareRuns: fakeCompareRuns, maxFindings: config.maxFindings });
  return buildExpressApp({
    config,
    service,
    loadRun: async (id) => {
      const stored = makeStored({ url: "https://india.gov.in/", findings: [] });
      stored.run.run_id = id;
      return stored;
    },
  });
}

beforeAll(async () => {
  server = http.createServer(makeApp(configFor()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("core routes", () => {
  it("healthz is open (no auth, no cache)", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("public config exposes base_url AND public_base_url aliases, allowed_origins, engine-true viewport and honest target roles", async () => {
    const payload = (await (await fetch(`${base}/api/v1/config`)).json()) as Record<string, unknown>;
    expect(payload["public_base_url"]).toBe("https://demo.example");
    expect(payload["base_url"]).toBe("https://demo.example");
    expect(Array.isArray(payload["allowed_origins"])).toBe(true);
    const conditions = payload["conditions"] as { viewport: { width: number; height: number } };
    // Engine contract (src/scanner.ts VIEWPORT) is 1280x800 — must match, never guess.
    expect(conditions.viewport).toEqual({ width: 1280, height: 800 });
    const targets = payload["targets"] as Array<{ url: string; role: string }>;
    expect(targets.some((t) => t.url === "https://www.india.gov.in/" && t.role === "government_read_only")).toBe(true);
    expect(targets.some((t) => t.role === "flawed_fixture_primary_demo")).toBe(true);
    expect(targets.some((t) => t.role === "corrected_reference_optional")).toBe(true);
    expect(targets.some((t) => t.role === "live_demo_fixture")).toBe(true);
  });

  it("audit and verification responses are no-store", async () => {
    const audit = await fetch(`${base}/api/v1/audits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://india.gov.in/" }) });
    expect(audit.status).toBe(200);
    expect(audit.headers.get("cache-control")).toBe("no-store");
  });

  it("strict body: extra fields and malformed JSON are 400 INVALID_ARGUMENT", async () => {
    const extra = await fetch(`${base}/api/v1/audits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://india.gov.in/", more: 1 }) });
    expect(extra.status).toBe(400);
    expect(((await extra.json()) as { error?: { code?: string } }).error?.code).toBe("INVALID_ARGUMENT");
    const malformed = await fetch(`${base}/api/v1/audits`, { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error?: { code?: string } }).error?.code).toBe("INVALID_ARGUMENT");
  });

  it("GET /mcp is 405 stateless; MCP POST output carries no-store", async () => {
    const notAllowed = await fetch(`${base}/mcp`, { method: "GET" });
    expect(notAllowed.status).toBe(405);
    const raw = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    expect([200, 400]).toContain(raw.status);
    expect(raw.headers.get("cache-control")).toBe("no-store");
  });
});

describe("CORS policy", () => {
  it("OPTIONS is 204 WITH headers already set for an allowed configured Origin", async () => {
    const corsServer = http.createServer(makeApp(configFor({ corsOrigins: ["https://frontend.example"] })));
    await new Promise<void>((resolve) => corsServer.listen(0, "127.0.0.1", resolve));
    const port = (corsServer.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/audits`, {
        method: "OPTIONS",
        headers: { origin: "https://frontend.example", "access-control-request-method": "POST" },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://frontend.example");
      expect(res.headers.get("access-control-allow-headers")).toContain("mcp-protocol-version");
    } finally {
      await new Promise<void>((resolve) => corsServer.close(() => resolve()));
    }
  });

  it("rejects unrelated Origins when a policy is configured (403 preflight; no CORS headers otherwise)", async () => {
    const corsServer = http.createServer(makeApp(configFor({ corsOrigins: ["https://frontend.example"] })));
    await new Promise<void>((resolve) => corsServer.listen(0, "127.0.0.1", resolve));
    const port = (corsServer.address() as { port: number }).port;
    try {
      const pre = await fetch(`http://127.0.0.1:${port}/api/v1/audits`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(pre.status).toBe(403);
      expect(pre.headers.get("access-control-allow-origin")).toBeNull();
      const real = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { origin: "https://evil.example" } });
      expect(real.status).toBe(200);
      expect(real.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => corsServer.close(() => resolve()));
    }
  });

  it("same-origin requests (no Origin header) are unaffected", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("content security policy routing", () => {
  it("fixtures get route-scoped inline-permitting CSP; API stays strict", async () => {
    const fixture = await fetch(`${base}/fixtures/registration.html`, { headers: { origin: "https://demo.example" } });
    expect(fixture.status).toBe(200);
    const fixtureCsp = fixture.headers.get("content-security-policy") ?? "";
    expect(fixtureCsp).toContain("unsafe-inline");
    const api = await fetch(`${base}/api/v1/config`, { headers: { origin: "https://demo.example" } });
    const apiCsp = api.headers.get("content-security-policy") ?? "";
    expect(apiCsp).not.toContain("unsafe-inline");
    expect(apiCsp).toContain("default-src 'self'");
  });
});

describe("fixture allowlist (directory read once, aliases, no traversal)", () => {
  it("serves engine's registration.html directly", async () => {
    const res = await fetch(`${base}/fixtures/registration.html`);
    expect(res.status).toBe(200);
    expect((res.headers.get("content-type") ?? "").includes("text/html")).toBe(true);
  });

  it("serves corrected.html and registration-corrected.html without renaming engine files", async () => {
    // Engine worker now deploys a real corrected.html; the alias map for
    // corrected.html → registration-corrected.html only applies when no real
    // corrected.html exists. Both routes must serve the engine's own files.
    const corrected = await fetch(`${base}/fixtures/corrected.html`);
    expect(corrected.status).toBe(200);
    const engineNative = await fetch(`${base}/fixtures/registration-corrected.html`);
    expect(engineNative.status).toBe(200);
    const a = await corrected.text();
    const b = await engineNative.text();
    expect(a.length).toBeGreaterThan(100);
    expect(b.length).toBeGreaterThan(100);
    // The alias mechanism itself is exercised when the real file is absent:
    // not-deployed names must never be fabricated, but a real alias target
    // (registered only if corrected.html were missing) is covered by the
    // allowlist unit below.
  });

  it("live-demo.html route exists and reports deployment state truthfully until orchestrator adds the file", async () => {
    // The route is part of the contract; without the file it must NOT 404-empty
    // but return a precise deployment error (never a fabricated page).
    const res = await fetch(`${base}/fixtures/live-demo.html`);
    if (res.status === 200) {
      expect((await res.text()).length).toBeGreaterThan(50);
    } else {
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("TARGET_UNREACHABLE");
    }
  });

  it("rejects unknown files and traversal attempts", async () => {
    const traversal = await fetch(`${base}/fixtures/..%2F..%2Fpackage.json`);
    expect(traversal.status).toBe(400);
    const unknown = await fetch(`${base}/fixtures/not-deployed.html`);
    expect(unknown.status).toBe(502);
    const chart = await fetch(`${base}/fixtures/chart.png`);
    // chart.png exists in the engine's fixture dir; assets from there are servable
    expect(chart.status).toBe(200);
    expect((chart.headers.get("content-type") ?? "").includes("image/png")).toBe(true);
  });

  it("alias fallback: corrected.html serves registration-corrected.html when the engine deploys only the native name", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fixtures-alias-"));
    try {
      await fs.writeFile(path.join(tempDir, "registration-corrected.html"), "<!doctype html><html lang=\"en\"><title>alias candidate</title><body>legacy corrected page</body></html>");
      const aliasApp = http.createServer(makeApp(configFor({ fixturesDir: tempDir })));
      await new Promise<void>((resolve) => aliasApp.listen(0, "127.0.0.1", resolve));
      const port = (aliasApp.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/fixtures/corrected.html`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("legacy corrected page");
      } finally {
        await new Promise<void>((resolve) => aliasApp.close(() => resolve()));
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("rate limiting (bounded scan budget)", () => {
  it("returns 429 RATE_LIMITED with Retry-After after the per-IP budget", async () => {
    const limServer = http.createServer(makeApp(configFor({ rateLimitPerIp: 2, rateLimitGlobal: 1000 })));
    await new Promise<void>((resolve) => limServer.listen(0, "127.0.0.1", resolve));
    const port = (limServer.address() as { port: number }).port;
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/verifications`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://india.gov.in/", baseline_id: "11111111-2222-3333-4444-555555555555" }),
        });
        expect(res.status).toBe(404); // engine would run; baseline unknown here
      }
      const third = await fetch(`http://127.0.0.1:${port}/api/v1/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://india.gov.in/", baseline_id: "11111111-2222-3333-4444-555555555555" }),
      });
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBeTruthy();
      expect(((await third.json()) as { error?: { code?: string } }).error?.code).toBe("RATE_LIMITED");
    } finally {
      await new Promise<void>((resolve) => limServer.close(() => resolve()));
    }
  });
});

describe("startup failure closes the engine (lifecycle leak regression)", () => {
  it("bind-occupied temporary port: startServer rejects EADDRINUSE and engine.close is called", async () => {
    // Simulate the unrelated-service collision (e.g. user's llama-server on 8080).
    const blocker = http.createServer((_req, res) => {
      res.end();
    });
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const occupiedPort = (blocker.address() as { port: number }).port;
    try {
      const engine = new FakeEngine([() => makeStored({ url: "https://india.gov.in/" })]);
      const closeSpy = vi.spyOn(engine, "close");
      let rejection: unknown;
      let started: unknown;
      try {
        started = await startServer(configFor({ port: occupiedPort, host: "127.0.0.1" }), engine, new InMemoryStore());
      } catch (err) {
        rejection = err;
      }
      expect(started).toBeUndefined();
      expect((rejection as NodeJS.ErrnoException | undefined)?.code).toBe("EADDRINUSE");
      // The engine (and its EgressProxy child) MUST be shut down so the
      // process does not hang forever after the failed startup.
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(engine.closed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("as a real child with the real engine, an occupied port exits nonzero promptly (no hang, no browser)", async () => {
    // Browser launch is lazy (per scan); createScanner only builds the
    // in-process EgressProxy, so this child never opens a browser.
    const serverJs = path.resolve(process.cwd(), "dist", "server.js");
    if (!existsSync(serverJs)) {
      throw new Error("dist/server.js missing: run `npm run build` before this test");
    }
    const blocker = http.createServer((_req, res) => {
      res.end();
    });
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const occupiedPort = (blocker.address() as { port: number }).port;
    try {
      const reportDir = "/tmp/opencode/startup-leak-runs";
      const child = spawn(process.execPath, [serverJs], {
        env: {
          ...process.env,
          PORT: String(occupiedPort),
          HOST: "127.0.0.1",
          ACCESSIBILITY_ALLOW_LOCAL: "true",
          ACCESSIBILITY_REPORT_DIR: reportDir,
          // Keep the scan-mode engine fully inert: no browser binary in tests.
          ACCESSIBILITY_BROWSER_EXECUTABLE: process.env["ACCESSIBILITY_BROWSER_EXECUTABLE"] ?? "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const exitCode: number | null = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`child did not exit within 20s on occupied port (startup hang regression): stderr=${stderr}`));
        }, 20_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("startup failed");
      expect(stderr).toContain("EADDRINUSE");
      // Cleanup evidence from startServer's failure path:
      expect(stderr).not.toContain("startup-cleanup] engine close failed");
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
