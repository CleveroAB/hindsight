'use client';

// One row of the strategy list: grid `1fr auto 220px` — name + description,
// right-aligned value + signed percent, then the sparkline (which fills its
// column, so the row scales with the list width) over a small year axis marking
// the backtested window. While the session's first
// backtest is still running the value/sparkline columns collapse into the
// pulsing dot + "Tinkering…". Whole row navigates to the expanded view.
//
// Right-clicking a row replaces the browser menu with the app's own (open /
// open in a new tab / delete). Delete goes through a confirm dialog because
// it's irreversible — a session's chat, code, and result all go with it — and
// deleting one mid-run also interrupts that run (see the DELETE route).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Session } from '@/lib/types';
import { deleteSession } from '@/lib/client/api';
import { formatMoney, formatSignedPercent, yearOf } from '@/lib/format';
import ConfirmDialog from './ConfirmDialog';
import ContextMenu from './ContextMenu';
import Sparkline from './Sparkline';

export interface StrategyRowProps {
  session: Session;
  /** Called after this session has been deleted server-side (list should reload). */
  onDeleted?: () => void;
}

export default function StrategyRow({ session, onDeleted }: StrategyRowProps) {
  const router = useRouter();
  const [hover, setHover] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const running = session.status === 'running' && session.result === null;
  const result = session.result;
  // Activated strategies get a live dot beside the name — but not while the
  // first run is still going, where the same dot already means "Tinkering…".
  const activation = running ? null : session.activation ?? null;

  // The window is shown as a year axis under the sparkline, so the description
  // no longer repeats it.
  const startYear = yearOf(session.period.start);
  const endYear = yearOf(session.period.end);
  const label = session.name || 'this strategy';

  const href = `/strategy/${session.id}`;
  const go = () => router.push(href);

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSession(session.id);
      setConfirming(false);
      onDeleted?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete this strategy.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={go}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto minmax(130px, 220px)',
          gap: 28,
          alignItems: 'center',
          padding: '22px 4px',
          borderBottom: '1px solid var(--hairline)',
          cursor: 'pointer',
          // Stays lit while its menu/dialog is open, so the target row is obvious.
          background: hover || menuAt || confirming ? 'rgba(127,127,127,0.06)' : 'transparent',
          transition: 'background 150ms ease',
          outline: 'none',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {session.name || 'Untitled strategy'}
            </div>
            {activation && (
              <div
                className="hs-pulse"
                title={activation.cadenceReason}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--green-stroke)',
                  flex: 'none',
                }}
              />
            )}
          </div>
          {session.description && (
            <div
              style={{
                fontSize: 13,
                color: 'var(--muted)',
                marginTop: 3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {session.description}
            </div>
          )}
        </div>

        {running ? (
          <div
            style={{
              gridColumn: '2 / 4',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 10,
            }}
          >
            <div
              className="hs-pulse"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--green-stroke)',
                flex: 'none',
              }}
            />
            <div style={{ fontSize: 14, color: 'var(--text)' }}>Tinkering…</div>
          </div>
        ) : result ? (
          <>
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
                {formatMoney(result.finalValue)}
              </div>
              <div
                className="num"
                style={{
                  fontSize: 13,
                  marginTop: 3,
                  color: result.returnPct >= 0 ? 'var(--green-text)' : 'var(--red)',
                }}
              >
                {formatSignedPercent(result.returnPct)}
              </div>
            </div>
            <div>
              <Sparkline
                values={result.equityCurve.map((p) => p.value)}
                returnPct={result.returnPct}
                width="100%"
              />
              {/* Year axis under the sparkline, laid out like the hero chart's
                  ticks: first year at the left edge, last at the right, so the
                  labels line up with the ends of the curve they describe. */}
              <div
                className="num"
                style={{
                  display: 'flex',
                  justifyContent: startYear === endYear ? 'center' : 'space-between',
                  fontSize: 11,
                  color: 'var(--muted)',
                  marginTop: 2,
                }}
              >
                <span>{startYear}</span>
                {startYear !== endYear && <span>{endYear}</span>}
              </div>
            </div>
          </>
        ) : (
          <div
            style={{
              gridColumn: '2 / 4',
              textAlign: 'right',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            Failed
          </div>
        )}
      </div>

      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          items={[
            { label: 'Open', onSelect: go },
            {
              label: 'Open in new tab',
              onSelect: () => window.open(href, '_blank', 'noopener'),
            },
            {
              label: 'Delete strategy',
              danger: true,
              separatorBefore: true,
              onSelect: () => {
                setDeleteError(null);
                setConfirming(true);
              },
            },
          ]}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title={`Delete ${label}?`}
          body={
            running
              ? 'Its run will be interrupted, and its chat, code, and results are removed. This cannot be undone.'
              : 'Its chat, code, and results are removed. This cannot be undone.'
          }
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          busy={deleting}
          errorText={deleteError}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
