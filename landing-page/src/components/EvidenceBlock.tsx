'use client';

import React, { useState } from 'react';
import { Copy, Check, Terminal } from 'lucide-react';

interface EvidenceBlockProps {
  html: string;
  targets: string[];
  failureSummary?: string | null;
  className?: string;
}

export const EvidenceBlock: React.FC<EvidenceBlockProps> = ({
  html,
  targets,
  failureSummary,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(html);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`space-y-2.5 ${className}`}>
      <div className="flex items-center justify-between text-xs text-white/50 font-mono tracking-wider">
        <span className="flex items-center gap-1.5 uppercase font-medium">
          <Terminal className="w-3.5 h-3.5 text-white/40" />
          Scanner DOM Evidence
        </span>
        <button
          onClick={handleCopy}
          aria-label="Copy evidence snippet to clipboard"
          className="flex items-center gap-1 text-[11px] text-white/50 hover:text-white transition-colors px-2 py-0.5 rounded border border-white/10 hover:border-white/25 bg-white/5"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy snippet</span>
            </>
          )}
        </button>
      </div>

      {/* Target path */}
      {targets.length > 0 && (
        <div className="text-[11px] font-mono text-purple-300/80 bg-purple-950/20 border border-purple-500/20 rounded-lg px-3 py-1.5 overflow-x-auto whitespace-nowrap">
          <span className="text-white/40 mr-1.5">selector:</span>
          {targets.join(', ')}
        </div>
      )}

      {/* Actual HTML node captured */}
      <div className="relative rounded-xl bg-black/60 border border-white/10 p-3.5 font-mono text-xs text-white/90 overflow-x-auto shadow-inner">
        <pre className="text-zinc-200">
          <code>{html}</code>
        </pre>
      </div>

      {/* Detailed scanner failure summary if provided by engine */}
      {failureSummary && (
        <div className="mt-2 text-[11px] font-mono text-white/60 bg-white/[0.03] border border-white/5 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">
          <span className="text-amber-400/80 block mb-1 font-semibold uppercase text-[10px] tracking-wider">
            Engine Rule Check Failure:
          </span>
          {failureSummary}
        </div>
      )}
    </div>
  );
};

export default EvidenceBlock;
