/**
 * Remote Streamable HTTP MCP transport (stateless).
 *
 * Exactly two tools: audit_page and verify_fixes, sharing the service layer.
 * Statelessness: POST /mcp creates a fresh McpServer + StreamableHTTPServerTransport
 * per request with sessionIdGenerator: undefined; GET/DELETE /mcp return 405.
 * Protocol returns structuredContent plus an agreeing compact text summary;
 * operational failures use isError:true with a structured error object.
 * No server-side LLM; the server never edits application source (readOnlyHint).
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, RequestHandler, Response } from "express";
import type { AccessibilityService } from "./service.js";
import type { ScanRun, VerificationResult } from "./contracts.js";
import { AppError, toAppError } from "./errors.js";

export const MCP_SERVER_NAME = "accessibility-companion";
export const MCP_SERVER_VERSION = "1.0.0";

export interface McpServerInfo {
  name: typeof MCP_SERVER_NAME;
  version: string;
}

const MCP_INSTRUCTIONS =
  "Accessibility Companion audits rendered pages for six selected accessibility categories " +
  "(eight axe rules) and verifies fixes against a saved baseline. " +
  "1) Call audit_page after a meaningful UI edit or before starting repairs; keep the run_id. " +
  "2) Inspect finding targets/snippets in the source with normal repository tools and repair violations " +
  "while preserving behavior. 3) Call verify_fixes with the SAME url and the baseline_id after edits. " +
  "A scan with violations is a normal result (gate=fail), not an error. Review items mean some results " +
  "need human/agent judgement and prevent a pass. Missing/disappeared elements are never counted as fixed. " +
  "A pass covers only the selected automated checks on the tested rendered state.";

function summarizeRun(run: ScanRun): string {
  const parts = [
    `gate=${run.gate}`,
    `rule categories covered=${run.coverage.categories.join(", ")}`,
    `violations: ${run.counts.violation_rule_count} rule(s), ${run.counts.violation_node_count} node(s)`,
  ];
  if (run.counts.incomplete_node_count > 0) parts.push(`incomplete nodes: ${run.counts.incomplete_node_count}`);
  parts.push(
    `returned findings: ${run.counts.returned_finding_count}${run.counts.omitted_finding_count > 0 ? ` (+${run.counts.omitted_finding_count} omitted)` : ""}`,
  );
  parts.push(`details_truncated=${run.details_truncated}`);
  if (run.review_items.length > 0) parts.push(`review items: ${run.review_items.length}`);
  if (run.gate === "pass") {
    parts.push(
      "No violations detected by the selected automated checks on the tested page state. " +
        "Other accessibility requirements and semantic correctness may still need manual review.",
    );
  }
  parts.push(`run_id=${run.run_id} report=${run.report_path}`);
  return parts.join("; ");
}

function toolSuccess(run: ScanRun) {
  const structured = { run } as const;
  return {
    structuredContent: structured,
    content: [
      { type: "text" as const, text: summarizeRun(run) },
      { type: "text" as const, text: JSON.stringify(run) },
    ],
  };
}

function toolSuccessVerification(verification: VerificationResult) {
  const structured = {
    schema_version: verification.schema_version,
    baseline_id: verification.baseline_id,
    current_run: verification.current_run,
    comparison: verification.comparison,
    gate: verification.gate,
    completion_claim: verification.completion_claim,
  };
  const summary = [
    `gate=${verification.gate}`,
    `remaining=${verification.comparison.remaining_ids.length}`,
    `newly_detected=${verification.comparison.newly_detected_ids.length}`,
    `no_longer_detected=${verification.comparison.no_longer_detected_ids.length}`,
    `uncertain=${verification.comparison.uncertain_baseline_ids.length}`,
    `current run_id=${verification.current_run.run_id}`,
    verification.completion_claim,
  ].join("; ");
  return {
    structuredContent: structured,
    content: [
      { type: "text" as const, text: summary },
      { type: "text" as const, text: JSON.stringify(structured) },
    ],
  };
}

function toolError(err: unknown) {
  const body = toAppError(err).toBody();
  return {
    isError: true as const,
    structuredContent: body,
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
  };
}

/** Registers exactly the two P0 tools on an McpServer instance. */
export function registerAccessibilityTools(server: McpServer, service: AccessibilityService): void {
  server.registerTool(
    "audit_page",
    {
      title: "Audit page accessibility",
      description:
        "Fresh complete scan of an allowed page for six accessibility categories " +
        "(contrast, image alt, label/select names, link names, button names, document language). " +
        "Call AFTER a meaningful UI edit batch and BEFORE repairs; keep the returned run_id as the future baseline. " +
        "A scan with violations is a successful tool call with gate=fail, not an error. " +
        "Incomplete results are returned as review items and prevent a pass.",
      inputSchema: {
        url: z.string().min(1).describe("Absolute http(s) URL on a permitted host (see GET /api/v1/config)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        return toolSuccess(await service.audit(url));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "verify_fixes",
    {
      title: "Verify accessibility fixes",
      description:
        "Load a saved baseline (run_id from a previous audit_page on the SAME url), perform a fresh scan of " +
        "that same url under matching conditions, and compare: remaining / newly_detected / no_longer_detected. " +
        "Disappeared findings are reported honestly (they may mean removal, hiding or movement, not repair). " +
        "Call after repair edits; after the final edit, cite the new run id in your completion response. " +
        "Incompatible baselines (different URL/conditions) return BASELINE_INCOMPATIBLE.",
      inputSchema: {
        url: z.string().min(1).describe("The SAME target URL used for the saved baseline."),
        baseline_id: z.string().min(1).describe("Opaque run_id from a previous successful audit_page."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, baseline_id }) => {
      try {
        return toolSuccessVerification(await service.verify(url, baseline_id));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

function buildServer(service: AccessibilityService): McpServer {
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    { instructions: MCP_INSTRUCTIONS },
  );
  registerAccessibilityTools(server, service);
  return server;
}

function badJson(res: Response): void {
  const err = new AppError("INVALID_ARGUMENT", "MCP requests must carry a JSON-RPC body.", "Send application/json MCP JSON-RPC POSTs to /mcp.");
  res.status(400).json(err.toBody());
}

/**
 * Stateless POST /mcp handler: fresh server+transport per request,
 * sessionIdGenerator undefined, cleanup on response close (not premature).
 */
export function createMcpRequestHandler(service: AccessibilityService): RequestHandler {
  return (req: Request, res: Response) => {
    if (req.body === undefined || req.body === null) {
      badJson(res);
      return;
    }
    void (async () => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const server = buildServer(service);
      // MCP outputs are capability-report-drivable and sensitive: never cache.
      res.setHeader("Cache-Control", "no-store");
      res.on("close", () => {
        // Cleanup when the response is finished — never before the response.
        void server.close().catch(() => undefined);
        void transport.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })().catch((err) => {
      // Transport layer failure before the transport could answer.
      if (!res.headersSent) {
        res.status(500);
      }
      if (!res.writableEnded) {
        res.end();
      }
      if (process.env["NODE_ENV"] !== "test") {
        console.error(`[mcp] request failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    });
  };
}

/** GET/DELETE /mcp → 405 (stateless server does not support standing sessions). */
export function mcpMethodNotAllowed(req: Request, res: Response): void {
  const err = new AppError(
    "INVALID_ARGUMENT",
    "This MCP server is stateless: no standing sessions over GET/DELETE. Use POST with JSON-RPC.",
    "Send tool calls as POST /mcp with application/json JSON-RPC.",
  );
  res.set("Allow", "POST").status(405).json(err.toBody());
}

/** Attach routes to an express app: POST /mcp (rate limiting applied by caller), GET/DELETE 405. */
export function attachMcpRoutes(app: { post: (p: string, h: RequestHandler) => unknown; get: (p: string, h: RequestHandler) => unknown; delete: (p: string, h: RequestHandler) => unknown }, service: AccessibilityService): void {
  app.post("/mcp", createMcpRequestHandler(service));
  app.get("/mcp", mcpMethodNotAllowed);
  app.delete("/mcp", mcpMethodNotAllowed);
}
