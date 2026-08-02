'use client';

// "Activate" affordance on the strategy page (beside Share, in the chart
// panel's control row). Activating arms a scheduled signal check whose cadence
// the server derives from the strategy itself (asset class + rebalance
// frequency) and starts texting the user whenever the target portfolio moves.
// The popover shows that derived schedule, the next check, the last signal, and
// a "Check now" button that runs one check immediately (it always sends a
// message, so the phone is proof the pipeline works).
//
// Anatomy is ShareControl's: prop→state sync, outside-click close, and the
// capture-phase Escape swallow — Escape here means "close this popover" and
// must never reach the strategy page's run-interrupt listener.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, SignalUpdate, StrategyActivation } from '@/lib/types';
import {
  activateSession,
  deactivateSession,
  getSignalsOverview,
  runSignalCheck,
} from '@/lib/client/api';
import { formatDatePill, formatSignedPercent } from '@/lib/format';

export interface ActivateControlProps {
  sessionId: string;
  /** The session's current activation, so a reload shows "Active" state. */
  activation?: StrategyActivation | null;
  /** True while a backtest run is in flight — every activation route 409s then. */
  disabled?: boolean;
  /**
   * Push the route's updated Session into page state — the activate and
   * deactivate responses carry the appended system chat note, which would
   * otherwise not appear until a full reload or the next run's refetch.
   */
  onSessionChange?: (session: Session) => void;
}

/** `Thu 16:20` — the next check in the viewer's own timezone. */
function formatNextCheck(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One line describing a check outcome: the bar it saw and what it said. */
function summarizeUpdate(update: SignalUpdate): string {
  const move = update.dayChangePct === null ? '' : ` · ${formatSignedPercent(update.dayChangePct)}`;
  if (update.inferred) {
    return `${formatDatePill(update.date)} · no position data yet${move}`;
  }
  if (update.changes.length === 0) {
    return `${formatDatePill(update.date)} · hold${move}`;
  }
  const moves = update.changes.map((change) => `${change.action} ${change.ticker}`).join(', ');
  return `${formatDatePill(update.date)} · ${moves}${move}`;
}

export default function ActivateControl({
  sessionId,
  activation: activationProp,
  disabled = false,
  onSessionChange,
}: ActivateControlProps) {
  const [open, setOpen] = useState(false);
  const [activation, setActivation] = useState<StrategyActivation | null>(activationProp ?? null);
  const [phone, setPhone] = useState('');
  const [phoneLoaded, setPhoneLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Don't let the flash reset fire into an unmounted component.
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  // Keep local state in sync if the session object refreshes underneath us.
  useEffect(() => {
    setActivation(activationProp ?? null);
  }, [activationProp]);

  const close = useCallback(() => {
    setOpen(false);
    setFlash(null);
    setError(null);
  }, []);

  // A run starting under an open popover would make every button in it 409.
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node) || !wrapRef.current?.contains(target)) close();
    };
    // Capture phase + stopPropagation: Escape here means "close this popover",
    // and must never reach the page's run-interrupt listener.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, close]);

  const handleOpen = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    setFlash(null);
    setError(null);
    // The default number lives in the server's env, so it can only be
    // prefilled lazily — and only while there is a number to fill in.
    if (!activation && !phoneLoaded) {
      getSignalsOverview()
        .then((overview) => {
          setPhoneLoaded(true);
          setPhone((current) => current || (overview.defaultPhone ?? ''));
        })
        .catch(() => setPhoneLoaded(true));
    }
  };

  const handleActivate = () => {
    setBusy(true);
    setError(null);
    const typed = phone.trim();
    activateSession(sessionId, typed || undefined)
      .then((session) => {
        setActivation(session.activation ?? null);
        onSessionChange?.(session);
      })
      .catch((err: Error) => setError(err.message || 'Couldn’t activate this strategy.'))
      .finally(() => setBusy(false));
  };

  const handleDeactivate = () => {
    setBusy(true);
    setError(null);
    deactivateSession(sessionId)
      .then((session) => {
        setActivation(session.activation ?? null);
        onSessionChange?.(session);
        close();
      })
      .catch((err: Error) => setError(err.message || 'Couldn’t deactivate this strategy.'))
      .finally(() => setBusy(false));
  };

  const handleCheckNow = () => {
    setChecking(true);
    setError(null);
    setFlash(null);
    runSignalCheck(sessionId)
      .then((res) => {
        // The route answers with the check outcome, not the session, so patch
        // the bookkeeping the popover shows; the next refetch makes it exact.
        setActivation((prev) =>
          prev
            ? {
                ...prev,
                lastCheckAt: Date.now(),
                lastSignal: res.update ?? prev.lastSignal,
                lastError: null,
              }
            : prev,
        );
        setFlash(res.update ? `Sent — ${summarizeUpdate(res.update)}` : 'Sent — no new bar has closed yet.');
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(null), 6000);
      })
      .catch((err: Error) => setError(err.message || 'The signal check failed.'))
      .finally(() => setChecking(false));
  };

  const active = activation !== null;

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleOpen}
        disabled={disabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          color: active ? 'var(--green-text)' : 'var(--muted)',
          border: 'none',
          background: 'transparent',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          padding: 0,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2.6 9.4a4.8 4.8 0 0 1 0-6.8M9.4 2.6a4.8 4.8 0 0 1 0 6.8M4.5 7.5a2.1 2.1 0 0 1 0-3M7.5 4.5a2.1 2.1 0 0 1 0 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
          <circle cx="6" cy="6" r="1" fill="currentColor" />
        </svg>
        {active ? 'Active' : 'Activate'}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Activate signal updates"
          className="hs-fade-in"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 320,
            padding: '14px 16px',
            background: 'var(--surface)',
            border: '1px solid var(--border-chrome)',
            borderRadius: 12,
            boxShadow: 'var(--card-shadow)',
            zIndex: 40,
            textAlign: 'left',
          }}
        >
          {activation ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                Signal updates are on
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', marginTop: 6 }}>
                {activation.cadenceReason}
              </div>
              <div className="num" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Next check {formatNextCheck(activation.nextCheckAt)}
              </div>
              {/* The destination must be visible — a silently redirected phone
                  number would otherwise be undetectable from inside the app. */}
              <div className="num" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Texting {activation.phone}
              </div>
              {activation.lastSignal ? (
                <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text)', marginTop: 8 }}>
                  Last signal · {summarizeUpdate(activation.lastSignal)}
                </div>
              ) : null}
              {activation.lastError ? (
                <div style={{ fontSize: 13, color: 'var(--red)', marginTop: 8 }}>
                  {activation.lastError}
                </div>
              ) : null}

              {error ? (
                <div style={{ fontSize: 13, color: 'var(--red)', marginTop: 8 }}>{error}</div>
              ) : flash ? (
                <div
                  className="hs-fade-in"
                  style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--green-text)', marginTop: 8 }}
                >
                  {flash}
                </div>
              ) : null}

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  marginTop: 12,
                }}
              >
                <button
                  type="button"
                  onClick={handleCheckNow}
                  disabled={checking || busy}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text)',
                    border: '1px solid var(--border-input)',
                    background: 'var(--surface)',
                    borderRadius: 'var(--r-pill)',
                    padding: '4px 10px',
                    cursor: checking || busy ? 'default' : 'pointer',
                    opacity: checking || busy ? 0.6 : 1,
                  }}
                >
                  {checking ? 'Checking…' : 'Check now'}
                </button>
                <button
                  type="button"
                  onClick={handleDeactivate}
                  disabled={busy || checking}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--red)',
                    border: 'none',
                    background: 'transparent',
                    cursor: busy || checking ? 'default' : 'pointer',
                    padding: 0,
                    opacity: busy || checking ? 0.6 : 1,
                  }}
                >
                  Deactivate
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--muted)' }}>
                Re-runs this strategy on a schedule derived from it, and texts you every time its
                target portfolio changes.
              </div>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) handleActivate();
                }}
                placeholder="+46701234567"
                aria-label="Phone number for signal messages"
                className="num"
                style={{
                  width: '100%',
                  marginTop: 10,
                  fontSize: 13,
                  color: 'var(--text)',
                  background: 'var(--bg)',
                  border: '1px solid var(--border-input)',
                  borderRadius: 'var(--r-pill)',
                  padding: '7px 10px',
                  outline: 'none',
                }}
              />
              {error ? (
                <div style={{ fontSize: 13, color: 'var(--red)', marginTop: 8 }}>{error}</div>
              ) : null}
              <button
                type="button"
                onClick={handleActivate}
                disabled={busy}
                style={{
                  marginTop: 10,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--primary-text)',
                  border: 'none',
                  background: 'var(--primary-bg)',
                  borderRadius: 'var(--r-pill)',
                  padding: '6px 12px',
                  cursor: busy ? 'default' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy ? 'Activating…' : 'Activate'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
