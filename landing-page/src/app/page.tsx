'use client';

import React, { useEffect, useState } from 'react';
import { ShaderBackground } from '@/components/ShaderBackground';
import { GlassInput } from '@/components/GlassInput';
import { AuditResults } from '@/components/AuditResults';
import { ScanRun, VerificationResult } from '@/lib/types';
import { auditPage, fetchPublicConfig, ApiError, PublicTarget } from '@/lib/api';
import { Loader2 } from 'lucide-react';

const FALLBACK_TARGETS: PublicTarget[] = [
  {
    label: 'Demo fixture (same origin)',
    url: '/fixtures/registration.html',
    role: 'flawed_fixture_primary_demo',
  },
  {
    label: 'India portal (read-only)',
    url: 'https://www.india.gov.in/',
    role: 'government_read_only',
  },
];

const PASS_STATEMENT =
  'No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review.';

export default function Home() {
  const [, setTargetUrl] = useState('');
  const [isAuditing, setIsAuditing] = useState(false);
  const [scanResult, setScanResult] = useState<ScanRun | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [quoteStyle, setQuoteStyle] = useState<'ai_question' | 'scope_note'>('ai_question');
  const [configTargets, setConfigTargets] = useState<PublicTarget[]>(FALLBACK_TARGETS);
  const [configError, setConfigError] = useState<string | null>(null);
  const [lastVerification, setLastVerification] = useState<VerificationResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPublicConfig().then(
      (cfg) => {
        if (cancelled) return;
        if (Array.isArray(cfg.targets) && cfg.targets.length > 0) {
          setConfigTargets(cfg.targets);
          setConfigError(null);
        }
      },
      (err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? `[${err.code}] ${err.message}`
            : 'Could not load the allowlisted targets from the backend.';
        setConfigError(`${msg} Showing the conservative built-in targets instead.`);
        setConfigTargets(FALLBACK_TARGETS);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Trigger audit flow — real backend only, no simulation.
  const handleStartAudit = async (url: string) => {
    setTargetUrl(url);
    setIsAuditing(true);
    setAuditError(null);
    setLastVerification(null);

    try {
      const result = await auditPage(url);
      setScanResult(result);
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? `[${err.code}] ${err.message} ${err.nextAction}`
          : err instanceof Error
            ? err.message
            : 'Failed to execute audit.';
      setAuditError(msg);
    } finally {
      setIsAuditing(false);
    }
  };

  const handleReset = () => {
    setScanResult(null);
    setAuditError(null);
    setIsAuditing(false);
    setLastVerification(null);
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden selection:bg-[#E8FD00] selection:text-black font-sans">
      {/* 1. Skip link for screen reader and keyboard accessibility */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:px-4 focus:py-2 focus:bg-[#E8FD00] focus:text-black focus:font-mono focus:text-xs focus:rounded focus:outline-none"
      >
        Skip to main content
      </a>

      {/* 2. WebGL Canvas Shader Background filling parent */}
      <ShaderBackground className="absolute inset-0" speed={0.9} />

      {/* 3. Main Content Layer */}
      <main id="main-content" className="relative z-10 min-h-screen flex flex-col justify-between">
        {scanResult ? (
          // Results View
          <AuditResults
            scanRun={scanResult}
            onReset={handleReset}
            onVerifyComplete={setLastVerification}
          />
        ) : (
          // Landing View — Exact match to reference screenshot
          <div className="flex-1 flex flex-col items-center justify-center px-4 md:px-6 py-12 md:py-24 text-center max-w-4xl mx-auto w-full">
            <div className="space-y-6 md:space-y-8 animate-fade-in w-full">
              {/* Wordmark: "Glorp" in elegant serif italic display */}
              <h1 className="font-serifDisplay italic text-6xl sm:text-7xl md:text-8xl lg:text-9xl text-white font-normal tracking-tight select-none drop-shadow-md">
                Glorp
              </h1>

              {/* Subtitle statement */}
              <div className="max-w-xl mx-auto text-center px-2">
                {quoteStyle === 'ai_question' ? (
                  <p className="text-base sm:text-lg md:text-xl text-white/90 font-light leading-relaxed tracking-normal">
                    AI can build a website in seconds.
                    <br />
                    <span className="text-white/70">
                      But can it tell you if everyone can use it?
                    </span>
                  </p>
                ) : (
                  <p className="text-base sm:text-lg md:text-xl text-white/90 font-light leading-relaxed tracking-normal">
                    This demo runs{' '}
                    <strong className="font-semibold text-white">
                      8 selected automated checks across 6 categories
                    </strong>{' '}
                    on one rendered page state — not a full WCAG audit. Manual review still applies.
                  </p>
                )}

                {/* Subtitle switch pill */}
                <div className="mt-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      setQuoteStyle(quoteStyle === 'ai_question' ? 'scope_note' : 'ai_question')
                    }
                    className="text-[11px] font-mono text-white/40 hover:text-white/80 transition-colors uppercase tracking-wider underline decoration-white/20 underline-offset-4"
                  >
                    {quoteStyle === 'ai_question'
                      ? 'Show what this demo checks'
                      : 'Show AI product prompt'}
                  </button>
                </div>
              </div>

              {/* Rectangular bright yellow highlight box: IS YOUR WEBSITE ACCESSIBLE? */}
              <div className="pt-2 pb-2">
                <div className="inline-block bg-[#E8FD00] text-black px-4 sm:px-6 py-1.5 sm:py-2 shadow-yellow-glow">
                  <span className="text-sm sm:text-base md:text-lg lg:text-xl font-bold tracking-wider uppercase font-serifDisplay select-none">
                    {quoteStyle === 'ai_question'
                      ? 'IS YOUR WEBSITE ACCESSIBLE?'
                      : 'CHECK THE SELECTED RULES'}
                  </span>
                </div>
              </div>

              {/* Liquid Glass URL Input */}
              <div className="pt-2 w-full max-w-2xl mx-auto">
                <GlassInput
                  onSubmit={handleStartAudit}
                  isLoading={isAuditing}
                  placeholder="Enter or paste a URL..."
                />
              </div>

              {/* Single truthful pending indicator (no staged progress claims) */}
              {isAuditing && (
                <div
                  role="status"
                  aria-live="polite"
                  className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-black/40 border border-white/10 backdrop-blur-md text-xs font-mono text-purple-200"
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-400" aria-hidden="true" />
                  <span>Scanning the rendered page…</span>
                </div>
              )}

              {/* Audit Error Alert */}
              {auditError && (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="max-w-md mx-auto p-3.5 rounded-xl bg-red-950/40 border border-red-500/40 text-xs text-red-200 font-mono text-center"
                >
                  <span>{auditError}</span>
                </div>
              )}

              {/* Allowlisted targets from GET /api/v1/config */}
              <div className="pt-8 flex flex-wrap items-center justify-center gap-2 text-xs font-mono text-white/40">
                <span className="uppercase text-[11px] tracking-wider text-white/30 mr-1">
                  Or test with:
                </span>
                {configTargets.slice(0, 4).map((sample) => (
                  <button
                    key={`${sample.role}:${sample.url}`}
                    type="button"
                    onClick={() => void handleStartAudit(sample.url)}
                    disabled={isAuditing}
                    title={sample.label}
                    className="px-2.5 py-1 rounded-md bg-white/[0.04] border border-white/10 hover:border-white/25 hover:text-white transition-colors disabled:opacity-50"
                  >
                    {sample.role === 'government_read_only'
                      ? 'india.gov.in (read-only)'
                      : sample.url.startsWith('/')
                        ? 'demo fixture'
                        : (() => {
                            try {
                              return new URL(sample.url, window.location.origin).hostname || sample.url;
                            } catch {
                              return sample.url;
                            }
                          })()}
                  </button>
                ))}
              </div>
              {configError && (
                <p role="status" className="text-[11px] font-mono text-amber-200/70 max-w-md mx-auto">
                  {configError}
                </p>
              )}
              <p className="text-[11px] font-mono text-white/30 max-w-md mx-auto">
                Scans are limited to the backend allowlist (own fixture + selected government domains).
                Other URLs are rejected by the server.
              </p>

              {/* Honest scope + connection details */}
              <div className="max-w-2xl mx-auto w-full space-y-3 pt-4 text-left">
                <details className="liquid-glass-card rounded-2xl p-4 text-xs font-mono text-white/60">
                  <summary className="cursor-pointer text-white/80 uppercase tracking-wider text-[11px] font-semibold">
                    What this demo checks (8 rules · 6 categories)
                  </summary>
                  <ul className="mt-3 space-y-1.5 font-sans text-[13px] text-white/70 leading-relaxed">
                    <li>Text contrast — <span className="font-mono text-[12px]">color-contrast</span></li>
                    <li>Image alternatives — <span className="font-mono text-[12px]">image-alt</span></li>
                    <li>Form labels — <span className="font-mono text-[12px]">label, select-name</span></li>
                    <li>Link names — <span className="font-mono text-[12px]">link-name</span></li>
                    <li>Button names — <span className="font-mono text-[12px]">button-name</span></li>
                    <li>Document language — <span className="font-mono text-[12px]">html-has-lang, html-lang-valid</span></li>
                  </ul>
                  <p className="mt-3 text-[11px] text-white/40 font-sans">
                    Automated subset only on one rendered page state (main document). Not a full WCAG
                    audit, certification, or legal compliance statement. Keyboard access, screen-reader
                    journeys, and reading order need human verification.
                  </p>
                  {lastVerification === null && scanResult === null && (
                    <p className="mt-2 text-[11px] text-white/40 font-sans italic">
                      A passing check means: “{PASS_STATEMENT}”
                    </p>
                  )}
                </details>

                <details className="liquid-glass-card rounded-2xl p-4 text-xs font-mono text-white/60">
                  <summary className="cursor-pointer text-white/80 uppercase tracking-wider text-[11px] font-semibold">
                    API & MCP connection details
                  </summary>
                  <div className="mt-3 space-y-2">
                    <p>Same-origin by default. Optional override: <span className="text-white/90">NEXT_PUBLIC_GLORP_API_URL</span> (public URL only, no secrets).</p>
                    <ul className="space-y-1 text-white/70">
                      <li><span className="text-white/90">POST</span> /api/v1/audits <span className="text-white/40">{'{ "url" }'}</span></li>
                      <li><span className="text-white/90">POST</span> /api/v1/verifications <span className="text-white/40">{'{ "url", "baseline_id" }'}</span></li>
                      <li><span className="text-white/90">GET</span> /api/v1/config · <span className="text-white/90">GET</span> /api/v1/runs/:run_id</li>
                      <li><span className="text-white/90">POST</span> /mcp — tools: <span className="text-white/90">audit_page, verify_fixes</span> (Streamable HTTP, stateless)</li>
                    </ul>
                    <pre className="bg-black/50 border border-white/10 rounded-lg p-3 overflow-x-auto text-[11px] text-white/80 whitespace-pre-wrap">
{`# MCP client (OpenCode V2 schema, no auth)
{
  "mcpServers": {
    "accessibility-companion": {
      "type": "streamableHttp",
      "url": "<DEPLOYED_BASE_URL>/mcp"
    }
  }
}
# REST
curl -X POST <DEPLOYED_BASE_URL>/api/v1/audits \\
  -H 'content-type: application/json' \\
  -d '{"url":"<DEPLOYED_BASE_URL>/fixtures/registration.html"}'`}
                    </pre>
                    <p className="text-[11px] text-white/40">
                      No API keys. Reports are anonymous capability IDs (24-hour TTL); anyone holding
                      an ID can read that report.
                    </p>
                  </div>
                </details>

                <details className="liquid-glass-card rounded-2xl p-4 text-xs text-white/60">
                  <summary className="cursor-pointer text-white/80 uppercase tracking-wider text-[11px] font-semibold font-mono">
                    Demo scope & repair loop honesty
                  </summary>
                  <div className="mt-3 space-y-2 font-sans text-[13px] text-white/70 leading-relaxed">
                    <p>
                      Government domains are scanned read-only for real detection — we never edit
                      government sites and never claim a government site was fixed.
                    </p>
                    <p>
                      Repairs to our own fixture happen in source via the coding agent (OpenCode),
                      redeployed at the SAME URL, then verified with{' '}
                      <span className="font-mono text-[12px]">verify_fixes(url, baseline_id)</span>.
                      Switching URLs is not repair evidence. This web UI does not auto-patch code.
                    </p>
                  </div>
                </details>
              </div>
            </div>
          </div>
        )}

        {/* Minimal Footer */}
        <footer className="w-full py-6 px-6 text-center text-xs font-mono text-white/30 select-none space-y-1">
          <p><span>Glorp</span> • Hosted hackathon demo — not production • Automated subset only, not full WCAG</p>
          <p className="text-[11px] text-white/20">Anonymous reports expire after 24h • Axe-core + Playwright detection</p>
        </footer>
      </main>
    </div>
  );
}
