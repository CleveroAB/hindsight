'use client';

// The ⓘ outline icon next to the change line. Hover (or keyboard focus) shows
// a small on-theme tooltip breaking down start value → end value, plus the
// annualized return when the period is long enough to support one.

import { useState } from 'react';
import { formatMoney, formatMoneyWhole, formatSignedPercent } from '@/lib/format';

export interface InfoTooltipProps {
  start: number;
  final: number;
  /** Annualized return in percent; null/absent hides the CAGR piece. */
  cagrPct?: number | null;
}

export default function InfoTooltip({ start, final, cagrPct = null }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const journey = `${formatMoneyWhole(start)} → ${formatMoney(final)}`;
  const cagr = cagrPct == null ? null : `${formatSignedPercent(cagrPct)} CAGR`;

  return (
    <span
      tabIndex={0}
      aria-label={cagr ? `${journey}, ${cagr}` : journey}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        outline: 'none',
        cursor: 'default',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--muted)" strokeWidth="1.2" />
        <path d="M8 7.2v3.4M8 5.1v.2" stroke="var(--muted)" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      {open && (
        <span
          role="tooltip"
          className="num hs-fade-in"
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 'calc(100% + 8px)',
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            background: 'var(--surface)',
            border: '1px solid var(--border-input)',
            borderRadius: cagr ? 'var(--r-card)' : 'var(--r-pill)',
            boxShadow: 'var(--card-shadow)',
            padding: '7px 12px',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--text)',
            zIndex: 10,
            pointerEvents: 'none',
          }}
        >
          <span style={{ display: 'block' }}>{journey}</span>
          {cagr && <span style={{ display: 'block', color: 'var(--muted)' }}>{cagr}</span>}
        </span>
      )}
    </span>
  );
}
