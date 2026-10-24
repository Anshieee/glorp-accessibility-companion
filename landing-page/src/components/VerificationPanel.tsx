'use client';

import React from 'react';
import { RefreshCw, CheckCircle, AlertTriangle, HelpCircle, ShieldCheck } from 'lucide-react';
import { VerificationResult, ScanRun } from '@/lib/types';
import { GateBadge } from './StatusBadge';

interface VerificationPanelProps {
  verificationResult: VerificationResult;
  baselineRun: ScanRun;
  onRescan: () => void;
  isRescanning?: boolean;
}

export const VerificationPanel: React.FC<VerificationPanelProps> = ({
  verificationResult,
  baselineRun,
  onRescan,
  isRescanning = false,
}) => {
  const comp = verificationResult.comparison;

  return (
    <div className="space-y-6">
      {/* Verification Lifecycle Stepper */}
      <div className="liquid-glass-card rounded-2xl p-5 md:p-6 border border-white/15">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-purple-300 tracking-wider uppercase font-semibold">
                Verification Lifecycle
              </span>
              <GateBadge gate={verificationResult.gate} />
            </div>
            <h3 className="text-lg font-medium text-white/95 mt-1">
              Differential Audit Verification
            </h3>
            <p className="text-xs text-white/60 font-mono mt-0.5">
              Baseline: {verificationResult.baseline_id} → Current: {verificationResult.current_run.run_id}
            </p>
            <p className="text-[11px] text-white/40 font-mono mt-1">
              Authoritative gate: verification result below (not the fresh scan alone).
              {verificationResult.comparison.comparable
                ? ' Same-URL comparison against the preserved baseline.'
                : ' Comparison not available.'}
            </p>
          </div>

          <button
            onClick={onRescan}
            disabled={isRescanning}
            className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/90 text-black hover:bg-white text-xs font-mono uppercase tracking-wider font-semibold transition-all hover:scale-105 active:scale-95 disabled:opacity-50 self-start md:self-center"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRescanning ? 'animate-spin' : ''}`} />
            {isRescanning ? 'Rescanning Page...' : 'Run Verification Rescan'}
          </button>
        </div>

        {/* Audit Pipeline Graph */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-4">
          {/* Step 1 */}
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/10 text-center">
            <span className="text-[10px] font-mono text-white/40 block mb-1">STAGE 1</span>
            <span className="text-xs font-semibold text-white/90">Baseline Audit</span>
            <span className="text-[10px] text-white/50 block mt-1 font-mono">
              {baselineRun.counts.violation_node_count} violations
            </span>
          </div>

          {/* Step 2 */}
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/10 text-center">
            <span className="text-[10px] font-mono text-white/40 block mb-1">STAGE 2</span>
            <span className="text-xs font-semibold text-white/90">Code Repairs</span>
            <span className="text-[10px] text-purple-300 block mt-1 font-mono">
              Host / Agent edits
            </span>
          </div>

          {/* Step 3 */}
          <div className="p-3 rounded-xl bg-purple-950/20 border border-purple-500/30 text-center">
            <span className="text-[10px] font-mono text-purple-300 block mb-1">STAGE 3</span>
            <span className="text-xs font-semibold text-purple-200">Fresh Rescan</span>
            <span className="text-[10px] text-purple-300/80 block mt-1 font-mono">
              Identical conditions
            </span>
          </div>

          {/* Step 4 */}
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/10 text-center">
            <span className="text-[10px] font-mono text-white/40 block mb-1">STAGE 4</span>
            <span className="text-xs font-semibold text-white/90">Truthful Delta</span>
            <span className="text-[10px] text-emerald-300 block mt-1 font-mono">
              Differential proof
            </span>
          </div>
        </div>

        {/* 4 Conservative Status Boxes */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-4">
          {/* No Longer Detected */}
          <div className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/25">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-emerald-300 font-semibold tracking-wider">
                No Longer Detected
              </span>
              <CheckCircle className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="text-2xl font-light text-emerald-200 mt-2 font-mono">
              {comp.no_longer_detected_ids.length}
            </div>
            <p className="text-[10px] text-emerald-300/70 mt-1 font-mono">
              Violations absent from current rendered DOM
            </p>
          </div>

          {/* Remaining */}
          <div className="p-4 rounded-xl bg-red-950/20 border border-red-500/25">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-red-300 font-semibold tracking-wider">
                Remaining
              </span>
              <AlertTriangle className="w-4 h-4 text-red-400" />
            </div>
            <div className="text-2xl font-light text-red-200 mt-2 font-mono">
              {comp.remaining_ids.length}
            </div>
            <p className="text-[10px] text-red-300/70 mt-1 font-mono">
              Violations persisting in fresh scan
            </p>
          </div>

          {/* Newly Detected */}
          <div className="p-4 rounded-xl bg-purple-950/20 border border-purple-500/25">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-purple-300 font-semibold tracking-wider">
                Newly Detected
              </span>
              <RefreshCw className="w-4 h-4 text-purple-400" />
            </div>
            <div className="text-2xl font-light text-purple-200 mt-2 font-mono">
              {comp.newly_detected_ids.length}
            </div>
            <p className="text-[10px] text-purple-300/70 mt-1 font-mono">
              Uncovered or introduced regression
            </p>
          </div>

          {/* Uncertain */}
          <div className="p-4 rounded-xl bg-amber-950/20 border border-amber-500/25">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-amber-300 font-semibold tracking-wider">
                Uncertain
              </span>
              <HelpCircle className="w-4 h-4 text-amber-400" />
            </div>
            <div className="text-2xl font-light text-amber-200 mt-2 font-mono">
              {comp.uncertain_baseline_ids.length}
            </div>
            <p className="text-[10px] text-amber-300/70 mt-1 font-mono">
              Node moved, replaced, or ambiguous match
            </p>
          </div>
        </div>

        {/* Verification Philosophy Alert */}
        <div className="mt-4 p-3.5 rounded-xl bg-white/[0.02] border border-white/10 text-xs text-white/70 flex items-start gap-3">
          <ShieldCheck className="w-4 h-4 text-purple-300 flex-shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium text-white/90">
              Glorp Verification Philosophy: Never automatically equate disappearance with a fix.
            </p>
            <p className="text-white/50 leading-relaxed font-sans">
              An element can disappear because it was removed, hidden with aria-hidden, or renamed. The scanner independently verifies whether the accessibility barrier is genuinely eliminated in the rendered page state.
            </p>
          </div>
        </div>

        {/* Comparator Notes */}
        {comp.notes.length > 0 && (
          <div className="mt-4 pt-3 border-t border-white/5 space-y-1">
            <span className="text-[10px] font-mono text-white/40 uppercase tracking-wider block">
              Comparator Diagnostics:
            </span>
            <ul className="space-y-1 text-xs text-white/70 font-mono">
              {comp.notes.map((note, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="text-purple-400 select-none">•</span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default VerificationPanel;
