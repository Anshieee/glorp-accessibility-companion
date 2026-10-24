import { useMemo } from "react";
import { BASE } from "../api/client";
import { CodeBlockWithCopy } from "./primitives";

export function ApiDocs() {
  const base = BASE || "<DEPLOYED_BASE_URL>";

  const auditExample = useMemo(
    () =>
      [
        `# Audit a page (allowlisted origins only)`,
        `curl -sS -X POST ${base}/api/v1/audits \\`,
        `  -H 'content-type: application/json' \\`,
        `  -d '{"url":"https://www.india.gov.in"}'`,
      ].join("\n"),
    [base],
  );

  const verifyExample = useMemo(
    () =>
      [
        `# Verify a fix against a saved baseline (same URL)`,
        `curl -sS -X POST ${base}/api/v1/verifications \\`,
        `  -H 'content-type: application/json' \\`,
        `  -d '{"url":"<SAME_URL>","baseline_id":"<RUN_ID>"}'`,
      ].join("\n"),
    [base],
  );

  return (
    <section className="panel" id="api-docs" aria-labelledby="apidocs-title">
      <h2 id="apidocs-title">
        API quickstart <span className="panel-tag">PROPOSED</span>
      </h2>
      <p className="subdued">
        The backend may later expose interactive docs at <code>GET /api/docs</code>; until the server is built, the
        requests below are the working reference.
      </p>
      <CodeBlockWithCopy code={auditExample} label="Audit request" />
      <CodeBlockWithCopy code={verifyExample} label="Verification request" />
      <details>
        <summary>About the contract</summary>
        <p className="subdued" style={{ marginTop: "0.4rem" }}>
          Errors return <code>{`{"execution":"failed","error":{"code","message","recoverable","next_action"}}`}</code> and
          may come with HTTP 4xx/5xx statuses. The <code>gate</code> can be{" "}
          <code>pass | fail | review_required | not_evaluated</code>. Runs expire after 24 hours.
        </p>
      </details>
    </section>
  );
}
