/**
 * MCP Streamable HTTP protocol test with the REAL official SDK client
 * (not just a direct function call). Uses a fake engine — the real browser
 * engine test is a separate integration concern owned by the tester.
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpRequestHandler, mcpMethodNotAllowed } from "../src/mcp.js";
import { createService } from "../src/service.js";
import { AppError } from "../src/errors.js";
import { FakeEngine, InMemoryStore, fakeCompareRuns, finding, makeStored } from "./fakes.js";

let app: Express;
let baseUrl: string;
let server: http.Server;
let storeDir: string;

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "256kb" }));
  const storeInstance = new InMemoryStore();
  const engine = new FakeEngine([
    () => makeStored({ url: "https://fixture.example/page", findings: [finding({ rule_id: "label", targets: ["#name"] })] }),
    () => makeStored({ url: "https://fixture.example/page", findings: [] }),
  ]);
  const service = createService({ engine, store: storeInstance, compareRuns: fakeCompareRuns, maxFindings: 100 });
  app.post("/mcp", createMcpRequestHandler(service));
  app.get("/mcp", mcpMethodNotAllowed);
  app.delete("/mcp", mcpMethodNotAllowed);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
  storeDir = await mkdtemp(path.join(os.tmpdir(), "acompanion-mcp-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.closeAllConnections?.() ?? server.close(() => resolve()));
  const { rm } = await import("node:fs/promises");
  await rm(storeDir, { recursive: true, force: true });
});

async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: "vitest-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl)));
  return { client, close: () => client.close() };
}

describe("MCP protocol discovery (stateless Streamable HTTP)", () => {
  it("initializes and advertises exactly the two tools with readOnlyHint annotations", async () => {
    const { client, close } = await connectClient();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["audit_page", "verify_fixes"]);
      for (const tool of tools.tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
      const audit = tools.tools.find((t) => t.name === "audit_page");
      expect(audit?.inputSchema).toBeDefined();
    } finally {
      await close();
    }
  });

  it("audit_page returns a structured run and agreeing text content", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({ name: "audit_page", arguments: { url: "https://fixture.example/page" } });
      expect(result.isError).not.toBe(true);
      const run = (result as { structuredContent?: { run?: Record<string, unknown> } }).structuredContent?.run;
      expect(run).toBeDefined();
      expect(run?.["gate"]).toBe("fail");
      expect(Array.isArray(run?.["findings"])).toBe(true);
      // text content present and consistent (JSON parse equals structured run)
      const texts = (result as { content: Array<{ type: string; text: string }> }).content.filter((c) => c.type === "text");
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.some((t) => (t.text as string).startsWith("gate=fail"))).toBe(true);
      expect(result as unknown).toBeDefined();
      const parsed = JSON.parse(texts.find((t) => t.text.startsWith("{"))!.text);
      expect(parsed).toEqual(run);
      // The returned run discount the baseline must exist for verify below.
      expect(typeof run?.["run_id"]).toBe("string");
    } finally {
      await close();
    }
  });

  it("verify_fixes returns a structured verification against the persisted baseline", async () => {
    const { client: auditClient, close: closeAudit } = await connectClient();
    const run = await auditClient.callTool({ name: "audit_page", arguments: { url: "https://fixture.example/page" } });
    await closeAudit();
    const runId = (run as { structuredContent?: { run?: { run_id: string } } })?.structuredContent?.run?.run_id;
    expect(runId).toBeTruthy();
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({ name: "verify_fixes", arguments: { url: "https://fixture.example/page", baseline_id: runId! } });
      expect(result.isError).not.toBe(true);
      const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
      expect(structured?.["baseline_id"]).toBe(runId);
      const comparison = structured?.["comparison"] as Record<string, unknown> | undefined;
      expect(comparison?.["comparable"]).toBe(true);
      expect(typeof structured?.["gate"]).toBe("string");
    } finally {
      await close();
    }
  });

  it("operational failures are isError=true with a structured error (code, next_action)", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "audit_page",
        arguments: { url: "https://fixture.example/page" },
      });
      // Fake engine has only 2 scripted responses; third call uses the last one
      // so force a failure instead via an invalid argument that the engine tolerates?
      void result;
      const failing = await client.callTool({ name: "verify_fixes", arguments: { url: "https://fixture.example/page", baseline_id: "11111111-2222-3333-4444-555555555555" } });
      expect(failing.isError).toBe(true);
      const body = (failing as { structuredContent?: { error?: { code?: string; next_action?: string } } }).structuredContent?.error;
      expect(body?.code).toBe("BASELINE_NOT_FOUND");
      expect(typeof body?.next_action).toBe("string");
    } finally {
      await close();
    }
  });

  it("tool handler catches service INVALID_ARGUMENT and returns a structured error", async () => {
    const { client, close } = await connectClient();
    try {
      // Service-level URL parse throws INVALID_ARGUMENT (whitespace-only url)
      const result = await client.callTool({ name: "audit_page", arguments: { url: "   " } });
      expect(result.isError).toBe(true);
      const body = (result as { structuredContent?: { error?: { code?: string } } }).structuredContent?.error;
      expect(body?.code).toBe("INVALID_ARGUMENT");
    } finally {
      await close();
    }
  });
});

describe("MCP transport method restrictions (stateless)", () => {
  it("GET /mcp and DELETE /mcp return 405", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const raw = await fetch(baseUrl, { method });
      expect(raw.status).toBe(405);
      expect(raw.headers.get("allow")).toContain("POST");
    }
  });

  it("malformed JSON-RPC body is rejected without a fabricated result", async () => {
    const raw = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ hello: "world" }),
    });
    // SDK transport rejects non-MCP bodies; never a fabricated tool result.
    expect([200, 400, 406]).toContain(raw.status);
    if (raw.status === 200) {
      const payload = (await raw.json()) as { result?: { isError?: boolean } | undefined; error?: { code?: number } };
      expect(payload.error !== undefined || payload.result?.isError === true).toBe(true);
    }
  });
});

describe("app error envelope availability", () => {
  it("AppError carries status for HTTP mapping", () => {
    expect(new AppError("SCAN_BUSY", "busy", "wait").status).toBe(503);
  });
});
