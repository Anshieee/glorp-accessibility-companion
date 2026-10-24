import { useMemo } from "react";
import { BASE } from "../api/client";
import { CodeBlockWithCopy } from "./primitives";

export function McpSetup() {
  const remoteUrl = BASE ? `${BASE}/mcp` : "<DEPLOYED_BASE_URL>/mcp";

  const mcpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            servers: {
              "accessibility-companion": {
                type: "remote",
                url: remoteUrl,
                oauth: false,
              },
            },
          },
        },
        null,
        2,
      ),
    [remoteUrl],
  );

  return (
    <section className="panel" aria-labelledby="mcp-title">
      <h2 id="mcp-title">
        MCP connection <span className="panel-tag">remote</span>
      </h2>
      <p className="subdued">
        Add this to your project's <code>opencode.json</code> (OpenCode v2 nests servers under{" "}
        <code>mcp.servers</code>). Merge it into your existing config — don't overwrite your file. Replace{" "}
        <code>&lt;DEPLOYED_BASE_URL&gt;</code> with the deployed API origin. The server exposes two tools:{" "}
        <code>audit_page(url)</code> and <code>verify_fixes(url, baseline_id)</code>.
      </p>
      <CodeBlockWithCopy code={mcpConfig} label="MCP" />
      <p className="subdued">
        Steps: paste the snippet → merge into your config → restart OpenCode → confirm the two tools appear via discovery
        (adding a config file alone doesn't prove connectivity).
      </p>
    </section>
  );
}
