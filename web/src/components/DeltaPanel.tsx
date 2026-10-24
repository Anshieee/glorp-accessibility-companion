import type { VerificationResult } from "../api/client";
import { CLEARANCE_TEXT, SCOPE_NOTE } from "../lib/presets";
import { GateBadge } from "./primitives";

export function DeltaPanel({ result }: { result: VerificationResult }) {
  const c = result.comparison;
  const remaining = c.remaining_ids ?? [];
  const newly = c.newly_detected_ids ?? [];
  const gone = c.no_longer_detected_ids ?? [];
  const uncertain = c.uncertain_baseline_ids ?? [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
        <GateBadge gate={result.gate} />
        <span className="subdued">verification gate</span>
      </div>

      <div className="delta-group">
        <h4 className="delta-bad">Still detected ({remaining.length})</h4>
        {remaining.length > 0 ? (
          <ul className="plain">
            {remaining.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ) : (
          <p className="subdued">None of the baseline findings were matched in the fresh scan.</p>
        )}
      </div>

      <div className="delta-group">
        <h4 className="delta-bad">Newly detected ({newly.length})</h4>
        {newly.length > 0 ? (
          <ul className="plain">
            {newly.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        ) : (
          <p className="subdued">No new selected-rule findings appeared.</p>
        )}
      </div>

      <div className="delta-group">
        <h4 className="delta-good">No longer detected ({gone.length})</h4>
        {gone.length > 0 ? (
          <>
            <ul className="plain">
              {gone.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
            <p className="subdued">
              “No longer detected” means the baseline finding is absent from the fresh scan — it is not a claim that the
              cause was definitively fixed (an element may have been removed, hidden, renamed, or moved).
            </p>
          </>
        ) : (
          <p className="subdued">No baseline findings are absent from the fresh scan.</p>
        )}
      </div>

      <div className="delta-group">
        <h4 className="delta-uncertain">Uncertain ({uncertain.length})</h4>
        {uncertain.length > 0 ? (
          <>
            <ul className="plain">
              {uncertain.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
            <p className="subdued">These comparisons were affected by missing/replaced targets or ambiguous matching.</p>
          </>
        ) : (
          <p className="subdued">None.</p>
        )}
      </div>

      {c.notes && c.notes.length > 0 ? (
        <div className="delta-group">
          <h4>Comparison notes</h4>
          <ul className="plain">
            {c.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.completion_claim ? (
        <p className="subdued" style={{ marginTop: "0.4rem" }}>
          <strong>Completion claim:</strong> {result.completion_claim}
        </p>
      ) : null}

      <p className="subdued" style={{ marginTop: "0.6rem" }}>
        {SCOPE_NOTE}
      </p>
      {result.gate === "pass" ? <p className="subdued">{CLEARANCE_TEXT}</p> : null}
    </div>
  );
}
