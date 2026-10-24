import { useEffect, useMemo, useState } from "react";
import { api, runApiUrl, type ApiClientError, type AppConfig, type ScanRun, type VerificationResult } from "../api/client";
import { FALLBACK_TARGETS, GATE_META, SCOPE_NOTE, SNIPPET_NOTE } from "../lib/presets";
import { ErrorBanner, GateBadge, Spinner } from "./primitives";
import { FindingsList } from "./FindingsList";
import { EvidencePanel } from "./EvidencePanel";
import { DeltaPanel } from "./DeltaPanel";

interface Baseline {
  runId: string;
  url: string;
}

/**
 * Canonical form used to decide whether two targets are the same page. Mirrors the
 * backend's canonicalTarget(): parse with URL, drop the fragment, keep the query, and
 * serialize (so "https://x.gov.in" and "https://x.gov.in/" compare equal). Falls back to
 * the trimmed raw string when the input is not a parseable URL.
 */
function normalizeTarget(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function DemoConsole() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [configUnavailable, setConfigUnavailable] = useState(false);
  const [targets, setTargets] = useState<Array<{ label: string; url: string }>>(FALLBACK_TARGETS);
  const [urlInput, setUrlInput] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");

  const [auditPending, setAuditPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [auditError, setAuditError] = useState<ApiClientError | null>(null);
  const [verifyError, setVerifyError] = useState<ApiClientError | null>(null);
  const [statusMsg, setStatusMsg] = useState("");

  const [lastAudit, setLastAudit] = useState<ScanRun | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [lastVerification, setLastVerification] = useState<VerificationResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .config()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        if (cfg.targets && cfg.targets.length > 0) {
          setTargets(cfg.targets);
          setUrlInput(cfg.targets[0]!.url);
          setSelectedPreset(cfg.targets[0]!.url);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setConfigUnavailable(true);
        // Fall back to explicit fixtures; never imply arbitrary URLs are accepted.
        setUrlInput(FALLBACK_TARGETS[0]!.url);
        setSelectedPreset(FALLBACK_TARGETS[0]!.url);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sameTarget = useMemo(() => {
    if (!baseline) return false;
    return normalizeTarget(urlInput) === normalizeTarget(baseline.url);
  }, [baseline, urlInput]);

  const canAudit = !auditPending && !verifyPending && urlInput.trim().length > 0;
  const canVerify = !auditPending && !verifyPending && baseline !== null && sameTarget;

  /**
   * Any change to the target input is a new target intent. A verification result that
   * belongs to a different canonical target must not remain on screen as if it described
   * the current input, so it is cleared. The saved baseline is left untouched.
   */
  function applyTargetInput(value: string) {
    setUrlInput(value);
    if (lastVerification && normalizeTarget(value) !== normalizeTarget(lastVerification.current_run.requested_url)) {
      setLastVerification(null);
    }
  }

  function handlePresetChange(value: string) {
    setSelectedPreset(value);
    applyTargetInput(value);
  }

  async function handleAudit() {
    const url = urlInput.trim();
    if (!url) return;
    setAuditPending(true);
    setAuditError(null);
    setVerifyError(null);
    setStatusMsg(`Auditing ${url}…`);
    try {
      const run = await api.audit(url);
      setLastAudit(run);
      setBaseline({ runId: run.run_id, url: run.requested_url });
      setLastVerification(null);
      setStatusMsg(`Audit complete. Gate: ${run.gate}. Baseline saved as ${run.run_id}.`);
    } catch (err) {
      const e = err as ApiClientError;
      setAuditError(e);
      setStatusMsg(`Audit failed: ${e.code} — ${e.message}`);
    } finally {
      setAuditPending(false);
    }
  }

  async function handleVerify() {
    if (!baseline) return;
    // Verify with the baseline's own recorded URL: the backend requires the same
    // canonical target as the baseline. The saved baseline is not modified here.
    const url = baseline.url;
    setVerifyPending(true);
    setAuditError(null);
    setVerifyError(null);
    setStatusMsg(`Verifying ${url} against baseline ${baseline.runId}…`);
    try {
      const result = await api.verify(url, baseline.runId);
      setLastVerification(result);
      setLastAudit(result.current_run);
      setStatusMsg(
        `Verification complete. Verification gate: ${GATE_META[result.gate].label}. Fresh scan selected-checks gate: ${GATE_META[result.current_run.gate].label}.`,
      );
    } catch (err) {
      const e = err as ApiClientError;
      setVerifyError(e);
      setStatusMsg(`Verification failed: ${e.code} — ${e.message}`);
    } finally {
      setVerifyPending(false);
    }
  }

  function handleResetBaseline() {
    setBaseline(null);
    setLastVerification(null);
    setStatusMsg("Baseline cleared. Run a new audit to set a fresh baseline.");
  }

  const activeRun = lastVerification ? lastVerification.current_run : lastAudit;

  return (
    <section className="panel" aria-labelledby="demo-title">
      <h2 id="demo-title">
        Demo console <span className="panel-tag">live</span>
      </h2>
      <p className="subdued">Scan a rendered page, then verify a source fix against the saved baseline.</p>

      {configUnavailable ? (
        <p className="subdued" role="note">
          The backend /api/v1/config is not reachable; using conservative fallback demo targets. Only allowlisted hosts are
          scanned — the backend validates and rejects anything else.
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleAudit();
        }}
      >
        <div className="field">
          <label htmlFor="preset">Preset target</label>
          <select
            id="preset"
            value={selectedPreset}
            onChange={(e) => handlePresetChange(e.target.value)}
            disabled={auditPending || verifyPending}
          >
            {targets.map((t) => (
              <option key={t.url} value={t.url}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="url">Page URL</label>
          <input
            id="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={urlInput}
            onChange={(e) => {
              applyTargetInput(e.target.value);
              setSelectedPreset("");
            }}
            disabled={auditPending || verifyPending}
            required
          />
          <div className="hint">
            Only allowlisted origins are scanned. The backend rejects anything else (e.g. localhost or unlisted hosts).
            {config?.allowed_hosts?.length ? ` Allowlisted hosts: ${config.allowed_hosts.join(", ")}.` : ""}
          </div>
        </div>

        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!canAudit}>
            {auditPending ? "Auditing…" : "Audit page"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void handleVerify()} disabled={!canVerify}>
            {verifyPending ? "Verifying…" : "Verify against baseline"}
          </button>
        </div>

        {!canVerify && baseline && !sameTarget && (
          <p className="hint" role="note">
            Verification requires the same target as the saved baseline. Change the URL back to the baseline target to enable
            it.
          </p>
        )}
      </form>

      <div aria-live="polite" className="live" style={{ marginTop: "0.9rem" }}>
        {auditPending ? <Spinner label="Running audit (spinner only — no fake progress)…" /> : null}
        {verifyPending ? <Spinner label="Running verification…" /> : null}
        {!auditPending && !verifyPending && statusMsg ? <span>{statusMsg}</span> : null}
        {!auditPending && !verifyPending && !statusMsg ? (
          <span>Enter a target URL, then choose Audit or Verify.</span>
        ) : null}
      </div>

      {auditError ? (
        <div style={{ marginTop: "0.8rem" }}>
          <ErrorBanner
            code={auditError.code}
            message={auditError.message}
            nextAction={auditError.next_action}
            recoverable={auditError.recoverable}
          />
        </div>
      ) : null}

      {verifyError ? (
        <div style={{ marginTop: "0.8rem" }}>
          <ErrorBanner
            code={verifyError.code}
            message={verifyError.message}
            nextAction={verifyError.next_action}
            recoverable={verifyError.recoverable}
          />
        </div>
      ) : null}

      {baseline ? (
        <div className="section" style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap" }}>
          <span className="subdued">
            Baseline: <code>{baseline.runId}</code> ({baseline.url})
          </span>
          <button type="button" className="btn btn-secondary" onClick={handleResetBaseline} style={{ padding: "0.25rem 0.7rem" }}>
            Reset baseline
          </button>
        </div>
      ) : null}

      {activeRun ? (
        <div className="section">
          <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", flexWrap: "wrap", marginBottom: "0.6rem" }}>
            {/* When a verification exists, its gate is authoritative (it can be review_required even if the fresh scan's selected checks pass). */}
            <GateBadge gate={lastVerification ? lastVerification.gate : activeRun.gate} />
            <span className="subdued">
              {lastVerification ? "verification gate" : "audit gate"} for {activeRun.requested_url}
            </span>
            {lastVerification ? (
              <span className="subdued">· fresh scan gate (selected checks only): {GATE_META[activeRun.gate].label}</span>
            ) : null}
            {activeRun.run_id ? (
              <span className="subdued">
                ·{" "}
                <a href={runApiUrl(activeRun.run_id)}>
                  run {activeRun.run_id}
                </a>{" "}
                (expires in 24h)
              </span>
            ) : null}
          </div>

          {normalizeTarget(activeRun.requested_url) !== normalizeTarget(urlInput) ? (
            <p className="hint" role="note">
              This result is for {activeRun.requested_url}, which is not the URL currently in the input. It is shown for
              reference only; audit or verify the current URL to update it.
            </p>
          ) : null}

          <p className="subdued">{SCOPE_NOTE}</p>

          {lastVerification ? <DeltaPanel result={lastVerification} /> : <FindingsList run={activeRun} />}

          <div style={{ borderTop: "1px solid var(--border)", marginTop: "1rem", paddingTop: "1rem" }}>
            <EvidencePanel run={activeRun} />
          </div>

          <p className="subdued" style={{ marginTop: "0.7rem" }}>
            {SNIPPET_NOTE}
          </p>
        </div>
      ) : null}
    </section>
  );
}
