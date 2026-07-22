'use client';

// The Period row under the chart: label, two date pills separated by a faint
// "–", and right-aligned actions — secondary "Refresh data" beside the primary
// "Run again" (which sits at the far right, per the design). "Run again" is
// disabled until a date changes; both are disabled while a re-run is active.

import { useEffect, useState } from 'react';
import type { Period } from '@/lib/types';
import DatePill from './DatePill';

export interface PeriodRowProps {
  period: Period;
  isRerunning: boolean;
  onRerun: (period: Period) => void;
  onRefresh: () => void;
}

export default function PeriodRow({ period, isRerunning, onRerun, onRefresh }: PeriodRowProps) {
  const [start, setStart] = useState(period.start);
  const [end, setEnd] = useState(period.end);

  // Re-sync drafts when the session's period changes (e.g. after a re-run).
  useEffect(() => {
    setStart(period.start);
    setEnd(period.end);
  }, [period.start, period.end]);

  const changed = start !== period.start || end !== period.end;
  // ISO dates compare correctly as strings; a reversed window can't be run.
  const ordered = start <= end;
  const canRun = changed && ordered && !isRerunning;
  const canRefresh = !isRerunning;

  return (
    <div
      style={{
        borderTop: '1px solid var(--hairline)',
        marginTop: 20,
        paddingTop: 18,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--muted)', marginRight: 4 }}>Period</div>
      <DatePill iso={start} onChange={setStart} disabled={isRerunning} ariaLabel="Period start date" />
      <div style={{ color: 'var(--faint)' }}>–</div>
      <DatePill iso={end} onChange={setEnd} disabled={isRerunning} ariaLabel="Period end date" />
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={onRefresh}
          disabled={!canRefresh}
          style={{
            border: '1px solid var(--border-input)',
            background: 'var(--surface)',
            color: 'var(--muted)',
            borderRadius: 'var(--r-pill)',
            padding: '9px 18px',
            fontSize: 13,
            fontWeight: 600,
            opacity: canRefresh ? 1 : 0.55,
            cursor: canRefresh ? 'pointer' : 'default',
            transition: 'opacity 150ms ease',
          }}
        >
          Refresh data
        </button>
        <button
          type="button"
          onClick={() => onRerun({ start, end })}
          disabled={!canRun}
          style={{
            background: 'var(--primary-bg)',
            color: 'var(--primary-text)',
            borderRadius: 'var(--r-pill)',
            padding: '9px 18px',
            fontSize: 13,
            fontWeight: 600,
            opacity: canRun ? 1 : 0.55,
            cursor: canRun ? 'pointer' : 'default',
            transition: 'opacity 150ms ease',
          }}
        >
          Run again
        </button>
      </div>
    </div>
  );
}
