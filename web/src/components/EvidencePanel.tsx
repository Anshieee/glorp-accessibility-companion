import type { ScanRun } from "../api/client";
import { REPORT_NOTE } from "../lib/presets";

export function EvidencePanel({ run }: { run: ScanRun }) {
  const engine = run.engine;
  const coverage = run.coverage;
  const warnings = run.warnings ?? [];
  const limitations = run.limitations ?? [];

  return (
    <div>
      <h3>Evidence &amp; scope</h3>
      <dl className="kv">
        {run.run_id ? (
          <>
            <dt>Scan ID</dt>
            <dd>{run.run_id}</dd>
          </>
        ) : null}
        {run.page_title ? (
          <>
            <dt>Page title</dt>
            <dd>{run.page_title}</dd>
          </>
        ) : null}
        <dt>Requested URL</dt>
        <dd>{run.requested_url}</dd>
        {run.final_url && run.final_url !== run.requested_url ? (
          <>
            <dt>Final URL</dt>
            <dd>{run.final_url}</dd>
          </>
        ) : null}
        {engine?.axe_version ? (
          <>
            <dt>axe-core</dt>
            <dd>v{engine.axe_version}</dd>
          </>
        ) : null}
        {engine?.playwright_version ? (
          <>
            <dt>Playwright</dt>
            <dd>v{engine.playwright_version}</dd>
          </>
        ) : null}
        {engine?.rule_ids && engine.rule_ids.length > 0 ? (
          <>
            <dt>Rules run</dt>
            <dd>{engine.rule_ids.join(", ")}</dd>
          </>
        ) : null}
        {coverage?.frame_coverage ? (
          <>
            <dt>Frame coverage</dt>
            <dd>{coverage.frame_coverage}</dd>
          </>
        ) : null}
        {run.details_truncated ? (
          <>
            <dt>Details</dt>
            <dd>truncated</dd>
          </>
        ) : null}
        {run.duration_ms != null ? (
          <>
            <dt>Duration</dt>
            <dd>{(run.duration_ms / 1000).toFixed(1)}s</dd>
          </>
        ) : null}
      </dl>

      {warnings.length > 0 ? (
        <>
          <h4 style={{ margin: "0.6rem 0 0.25rem", fontSize: "0.9rem" }}>Warnings</h4>
          <ul className="plain">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}

      {limitations.length > 0 ? (
        <>
          <h4 style={{ margin: "0.6rem 0 0.25rem", fontSize: "0.9rem" }}>Limitations</h4>
          <ul className="plain">
            {limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="subdued" style={{ marginTop: "0.6rem" }}>
        {REPORT_NOTE}
      </p>
    </div>
  );
}
