'use client';

// "Share" affordance on the strategy page (right column of the chart panel,
// under the name/meta block). Clicking it does everything: mints the share
// token AND starts the cloudflared tunnel server-side (idempotent POST), then
// shows only the finished public link with a copy button. Stop sharing revokes
// the token and closes the tunnel. If `cloudflared` isn't installed on this
// machine the popover says so instead of pretending the link is reachable.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareInfo } from '@/lib/types';
import { shareSession, unshareSession } from '@/lib/client/api';

export interface ShareControlProps {
  sessionId: string;
  /** The session's current token, so a reload shows "Shared" state. */
  shareToken?: string | null;
}

export default function ShareControl({ sessionId, shareToken }: ShareControlProps) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [token, setToken] = useState<string | null>(shareToken ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Don't let the "Copied" reset fire into an unmounted component.
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // Keep local state in sync if the session object refreshes underneath us.
  useEffect(() => {
    setToken(shareToken ?? null);
  }, [shareToken]);

  const close = useCallback(() => {
    setOpen(false);
    setCopied(false);
    setError(null);
  }, []);

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
    setBusy(true);
    setError(null);
    shareSession(sessionId)
      .then((res) => {
        setInfo(res);
        setToken(res.token);
      })
      .catch((err: Error) => setError(err.message || 'Couldn’t create the share link.'))
      .finally(() => setBusy(false));
  };

  const handleUnshare = () => {
    setBusy(true);
    unshareSession(sessionId)
      .then(() => {
        setToken(null);
        setInfo(null);
        close();
      })
      .catch((err: Error) => setError(err.message || 'Couldn’t stop sharing.'))
      .finally(() => setBusy(false));
  };

  const shareUrl = info?.url ?? null;

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
      },
      // Clipboard access can be denied; the link is visible, so just say so.
      () => setError('Couldn’t copy — select the link and copy it manually.'),
    );
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleOpen}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          color: token ? 'var(--green-text)' : 'var(--muted)',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M4.5 6.5 8 3M8 3h-2.6M8 3v2.6M6 1.5H2.5v8h8V6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {token ? 'Shared' : 'Share'}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Share this strategy"
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
          {busy && !info ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>Starting secure tunnel…</div>
          ) : error ? (
            <div style={{ fontSize: 13, color: 'var(--red)' }}>{error}</div>
          ) : info ? (
            <>
              {shareUrl ? (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                    Read-only share link
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 8,
                    }}
                  >
                    <code
                      style={{
                        flex: 1,
                        fontSize: 11,
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {shareUrl}
                    </code>
                    <button
                      type="button"
                      onClick={() => copy(shareUrl)}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: 'var(--text)',
                        border: '1px solid var(--border-input)',
                        background: 'var(--surface)',
                        borderRadius: 'var(--r-pill)',
                        padding: '4px 10px',
                        cursor: 'pointer',
                        flex: 'none',
                      }}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: 'var(--muted)',
                      marginTop: 10,
                    }}
                  >
                    Anyone with the link can view this strategy, read-only. Everything else 404s.
                    The link works while the app is running; stopping the share closes the tunnel.
                  </div>
                </>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: 'var(--red)',
                  }}
                >
                  cloudflared isn’t installed, so the share link can’t leave your machine. Install
                  it (<code style={{ fontSize: 11 }}>brew install cloudflared</code>) and press
                  Share again.
                </div>
              )}

              <button
                type="button"
                onClick={handleUnshare}
                disabled={busy}
                style={{
                  marginTop: 12,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--red)',
                  border: 'none',
                  background: 'transparent',
                  cursor: busy ? 'default' : 'pointer',
                  padding: 0,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                Stop sharing
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
