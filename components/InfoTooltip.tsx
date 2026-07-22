'use client';

// The ⓘ outline icon next to the change line. Hover (or keyboard focus) shows
// a small on-theme tooltip breaking down start value → end value.

import { useState } from 'react';
import { formatMoney, formatMoneyWhole } from '@/lib/format';

export interface InfoTooltipProps {
  start: number;
  final: number;
}

export default function InfoTooltip({ start, final }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const text = `${formatMoneyWhole(start)} → ${formatMoney(final)}`;

  return (
    <span
      tabIndex={0}
      aria-label={text}
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
            borderRadius: 'var(--r-pill)',
            boxShadow: 'var(--card-shadow)',
            padding: '7px 12px',
            fontSize: 12,
            color: 'var(--text)',
            zIndex: 10,
            pointerEvents: 'none',
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
