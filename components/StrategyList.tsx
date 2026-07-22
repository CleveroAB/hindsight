'use client';

// Screen 04 — the strategy list. Centered column (up to 1120px), 40px top
// padding: "Strategies" title + "+ New" pill, one StrategyRow per session, and
// a quiet "＋ New strategy" affordance as the last row. The rows scroll with no
// visible scrollbar, and end 40px clear of the bottom edge.
//
// The column is wide rather than text-measure narrow: rows are three columns of
// data (name, value, sparkline), not prose, so the extra width goes into longer
// un-truncated descriptions and a bigger sparkline instead of empty gutters.

import type { Session } from '@/lib/types';
import StrategyRow from './StrategyRow';

export interface StrategyListProps {
  sessions: Session[];
  onNew: () => void;
  /** A row deleted itself (right-click → Delete); reload the list. */
  onDeleted?: () => void;
}

export default function StrategyList({ sessions, onNew, onDeleted }: StrategyListProps) {
  return (
    <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minHeight: 0 }}>
      <div
        className="hs-fade-in"
        style={{
          width: '100%',
          maxWidth: 1120,
          paddingTop: 40,
          paddingLeft: 32,
          paddingRight: 32,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 8,
            flex: 'none',
          }}
        >
          <h1
            style={{
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              color: 'var(--text)',
              margin: 0,
            }}
          >
            Strategies
          </h1>
          <button
            type="button"
            onClick={onNew}
            style={{
              border: '1px solid var(--border-input)',
              background: 'var(--surface)',
              borderRadius: 'var(--r-round)',
              padding: '7px 16px',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text)',
            }}
          >
            + New
          </button>
        </div>

        {/* paddingBottom keeps "＋ New strategy" clear of the window edge when
            scrolled to the bottom, instead of sitting flush against it. */}
        <div className="hs-scroll-hidden" style={{ flex: 1, minHeight: 0, paddingBottom: 40 }}>
          {sessions.map((session) => (
            <StrategyRow key={session.id} session={session} onDeleted={onDeleted} />
          ))}
          <button
            type="button"
            onClick={onNew}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '22px 4px',
              fontSize: 14,
              color: 'var(--muted)',
            }}
          >
            ＋ New strategy
          </button>
        </div>
      </div>
    </div>
  );
}
