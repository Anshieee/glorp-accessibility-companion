'use client';

import React from 'react';
import { Impact, Gate, DeltaStatus } from '@/lib/types';

interface ImpactBadgeProps {
  impact: Impact;
  className?: string;
}

export const ImpactBadge: React.FC<ImpactBadgeProps> = ({ impact, className = '' }) => {
  if (!impact) return null;

  const config = {
    critical: {
      label: 'CRITICAL',
      bg: 'bg-red-500/15 border-red-500/40 text-red-200',
      dot: 'bg-red-400',
    },
    serious: {
      label: 'SERIOUS',
      bg: 'bg-orange-500/15 border-orange-500/40 text-orange-200',
      dot: 'bg-orange-400',
    },
    moderate: {
      label: 'MODERATE',
      bg: 'bg-yellow-500/15 border-yellow-500/40 text-yellow-200',
      dot: 'bg-yellow-400',
    },
    minor: {
      label: 'MINOR',
      bg: 'bg-blue-500/15 border-blue-500/40 text-blue-200',
      dot: 'bg-blue-400',
    },
  }[impact];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono tracking-wider font-medium border backdrop-blur-md ${config.bg} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} aria-hidden="true" />
      {config.label}
    </span>
  );
};

interface GateBadgeProps {
  gate: Gate;
  className?: string;
}

export const GateBadge: React.FC<GateBadgeProps> = ({ gate, className = '' }) => {
  const config = {
    pass: {
      label: 'GATE PASSED',
      bg: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
    },
    fail: {
      label: 'GATE FAILED',
      bg: 'bg-rose-500/15 border-rose-500/40 text-rose-200',
    },
    review_required: {
      label: 'REVIEW REQUIRED',
      bg: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
    },
    not_evaluated: {
      label: 'NOT EVALUATED',
      bg: 'bg-zinc-500/15 border-zinc-500/40 text-zinc-300',
    },
  }[gate];

  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-mono tracking-widest uppercase font-semibold border backdrop-blur-md ${config.bg} ${className}`}
    >
      {config.label}
    </span>
  );
};

interface DeltaBadgeProps {
  status: DeltaStatus;
  className?: string;
}

export const DeltaBadge: React.FC<DeltaBadgeProps> = ({ status, className = '' }) => {
  const config = {
    remaining: {
      label: 'REMAINING',
      bg: 'bg-red-500/15 border-red-500/40 text-red-200',
      desc: 'Still detected in fresh scan',
    },
    newly_detected: {
      label: 'NEWLY DETECTED',
      bg: 'bg-purple-500/15 border-purple-500/40 text-purple-200',
      desc: 'Introduced or uncovered during modifications',
    },
    no_longer_detected: {
      label: 'NO LONGER DETECTED',
      bg: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
      desc: 'Absent in current scan (requires runtime verification)',
    },
    uncertain: {
      label: 'UNCERTAIN',
      bg: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
      desc: 'Target node moved, renamed or restructured',
    },
  }[status];

  return (
    <span
      title={config.desc}
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-mono tracking-wider font-semibold border backdrop-blur-md ${config.bg} ${className}`}
    >
      {config.label}
    </span>
  );
};
