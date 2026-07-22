'use client';

// The Compare control under the change line: a small icon-only pill that
// overlays a buy-and-hold curve for the comparable equity (e.g. QQQ for a QQQ
// strategy) on the hero chart. Icon-only per the design — once the overlay is
// on, a quiet legend beside it names the symbol and its return, which is also
// what identifies the dashed line on the chart.

import { formatSignedPercent } from '@/lib/format';

export interface CompareToggleProps {
  active: boolean;
  loading: boolean;
  /** Symbol being compared against; null until the first fetch resolves. */
  ticker: string | null;
  /** Buy-and-hold return of that symbol over the same period, if loaded. */
  returnPct: number | null;
  /** Human-readable failure from the last attempt, if any. */
  error: string | null;
  disabled?: boolean;
  onToggle: () => void;
}

/** Two trend lines — a solid strategy curve over a dashed benchmark. */
function CompareIcon({ color }: { color: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M1 12 L12.6 5.2"
        fill="none"
        stroke={color}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeDasharray="2.4 2.2"
        opacity="0.75"
      />
      <path
        d="M1 9.4 L4.6 6 L7.4 8.2 L13 1.8"
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function CompareToggle({
  active,
  loading,
  ticker,
  returnPct,
  error,
  disabled = false,
  onToggle,
}: CompareToggleProps) {
  const label = ticker ? `Compare with ${ticker}` : 'Compare with a benchmark';
  const iconColor = active ? 'var(--text)' : 'var(--icon)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 10, minHeight: 26 }}>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || loading}
        aria-pressed={active}
        aria-label={label}
        title={label}
        style={{
          height: 26,
          padding: '0 9px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${active ? 'var(--border-chrome)' : 'var(--border-input)'}`,
          background: active ? 'var(--bubble)' : 'var(--surface)',
          borderRadius: 'var(--r-pill)',
          opacity: disabled ? 0.55 : 1,
          cursor: disabled || loading ? 'default' : 'pointer',
          transition: 'background-color 150ms ease, border-color 150ms ease, opacity 150ms ease',
          flex: 'none',
        }}
      >
        {loading ? (
          <span
            className="hs-spin"
            style={{
              width: 12,
              height: 12,
              border: '2px solid var(--spinner-track)',
              borderTopColor: 'var(--icon)',
              borderRadius: '50%',
              display: 'block',
            }}
          />
        ) : (
          <CompareIcon color={iconColor} />
        )}
      </button>

      {error ? (
        <span className="hs-fade-in" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {error}
        </span>
      ) : active && ticker ? (
        <span
          className="hs-fade-in"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <svg width="16" height="6" viewBox="0 0 16 6" aria-hidden="true" style={{ flex: 'none' }}>
            <path
              d="M0 3 H16"
              stroke="var(--benchmark)"
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          </svg>
          <span className="num" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {ticker} buy &amp; hold
            {returnPct === null ? '' : ` ${formatSignedPercent(returnPct)}`}
          </span>
        </span>
      ) : null}
    </div>
  );
}
