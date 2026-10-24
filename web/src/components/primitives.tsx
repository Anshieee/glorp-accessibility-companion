import { useEffect, useState, type ReactNode } from "react";
import type { Gate } from "../api/client";
import { GATE_META } from "../lib/presets";

export function Spinner({ label }: { label: string }) {
  return (
    <span className="live" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

const GATE_GLYPH: Record<Gate, string> = {
  pass: "✓",
  fail: "!",
  review_required: "?",
  not_evaluated: "—",
};

export function GateBadge({ gate }: { gate: Gate }) {
  const meta = GATE_META[gate];
  return (
    <span className={`gate-badge gate-${meta.tone}`}>
      <span aria-hidden="true">{GATE_GLYPH[gate]}</span>
      {meta.label}
    </span>
  );
}

export function ErrorBanner({
  code,
  message,
  nextAction,
  recoverable,
}: {
  code: string;
  message: string;
  nextAction?: string;
  recoverable: boolean;
}) {
  return (
    <div className="error-banner" role="alert">
      <strong>Error {code}</strong>
      {" — "}
      {message}
      {nextAction ? <span className="next-action">{nextAction}</span> : null}
      {recoverable ? <span className="next-action">This error may be recoverable — you can retry.</span> : null}
    </div>
  );
}

export function CodeBlockWithCopy({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* clipboard unavailable — leave unchanged */
    }
  }

  return (
    <div className="code-block" tabIndex={0} aria-label={`${label} configuration`}>
      {code}
      <button type="button" className="copy-btn" onClick={handleCopy}>
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

export function InlineNote({ children }: { children: ReactNode }) {
  return <p className="note-strip">{children}</p>;
}
