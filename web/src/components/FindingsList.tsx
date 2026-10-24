import type { Finding, ReviewItem, ScanRun } from "../api/client";
import { categoryForRule, sortFindings } from "../lib/presets";

function safeHelpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* ignore malformed */
  }
  return undefined;
}

function FindingCard({ finding }: { finding: Finding }) {
  const helpUrl = safeHelpUrl(finding.help_url);
  return (
    <li className="finding">
      <div className="finding-head">
        {finding.impact ? (
          <span className={`impact-chip impact-${finding.impact}`}>{finding.impact}</span>
        ) : null}
        <span className="rule-chip">{finding.rule_id}</span>
        <span className="subdued">{categoryForRule(finding.rule_id)}</span>
      </div>
      {finding.description ? <p>{finding.description}</p> : null}
      {finding.html ? (
        <>
          <div className="subdued" style={{ fontSize: "0.82rem" }}>
            Snippet (untrusted, may be redacted):
          </div>
          <pre className="snippet">{finding.html}</pre>
        </>
      ) : null}
      {finding.guidance ? <div className="guidance">{finding.guidance}</div> : null}
      {helpUrl ? (
        <div className="help-link">
          <a href={helpUrl} target="_blank" rel="noopener noreferrer">
            More on this rule (external, opens in new tab)
          </a>
        </div>
      ) : null}
    </li>
  );
}

function ReviewItemCard({ item }: { item: ReviewItem }) {
  return (
    <li className="finding">
      <div className="finding-head">
        <span className="rule-chip">{item.rule_id}</span>
        <span className="subdued">review item</span>
      </div>
      {item.reason ? <p>{item.reason}</p> : null}
      {item.html ? <pre className="snippet">{item.html}</pre> : null}
    </li>
  );
}

export function FindingsList({ run }: { run: ScanRun }) {
  const sorted = [...run.findings].sort(sortFindings);
  const counts = run.counts;

  return (
    <div>
      <div className="stat-row">
        <div className="stat">
          <b>{counts.violation_rule_count}</b>
          <span>rules with violations</span>
        </div>
        <div className="stat">
          <b>{counts.violation_node_count}</b>
          <span>affected nodes</span>
        </div>
        <div className="stat">
          <b>{counts.incomplete_node_count}</b>
          <span>incomplete checks</span>
        </div>
        <div className="stat">
          <b>{run.review_items.length}</b>
          <span>review items</span>
        </div>
      </div>

      {counts.omitted_finding_count > 0 ? (
        <p className="subdued">
          {counts.omitted_finding_count} additional finding{counts.omitted_finding_count === 1 ? "" : "s"} omitted from
          this display (display cap). The gate is still calculated from the full result.
        </p>
      ) : null}

      {run.findings.length > 0 ? (
        <ul className="plain" style={{ listStyle: "none", paddingLeft: 0 }}>
          {sorted.map((f, i) => (
            <FindingCard key={f.id ?? `${f.rule_id}-${i}`} finding={f} />
          ))}
        </ul>
      ) : (
        <p className="subdued">No violation findings were returned for the selected rules on this page state.</p>
      )}

      {run.review_items.length > 0 ? (
        <>
          <h3 style={{ marginTop: "1.1rem" }}>Manual review items</h3>
          <ul className="plain" style={{ listStyle: "none", paddingLeft: 0 }}>
            {run.review_items.map((r, i) => (
              <ReviewItemCard key={i} item={r} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
