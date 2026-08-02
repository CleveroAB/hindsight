'use client';

// Interactive strategy explanation beside the Share control. The panel uses
// the exact agent response associated with the currently presented backtest,
// adds a concise summary + snapshot, and lets the whole explanation be copied.

import { useEffect, useRef, useState } from 'react';
import CopyToast from './CopyToast';

export interface StrategyExplanationProps {
  name: string;
  summary: string;
  details: string;
  snapshot: string;
  versionLabel?: string | null;
}

type ToastState = 'copied' | 'error' | null;

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Fallback for browsers that do not expose the async Clipboard API.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard copy failed');
}

export default function StrategyExplanation({
  name,
  summary,
  details,
  snapshot,
  versionLabel = null,
}: StrategyExplanationProps) {
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !wrapRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const showToast = (next: Exclude<ToastState, null>) => {
    setToast(next);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const copyExplanation = async () => {
    const sections = [name, summary];
    if (details !== summary) sections.push(details);
    sections.push(`${versionLabel ? `${versionLabel} · ` : ''}${snapshot}`);

    try {
      await writeClipboard(sections.join('\n\n'));
      showToast('copied');
    } catch {
      showToast('error');
    }
  };

  return (
    <div
      ref={wrapRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!wrapRef.current?.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpen(false);
      }}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      <button
        type="button"
        aria-label={`Explain ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: open ? 'var(--text)' : 'var(--muted)',
          background: open ? 'rgba(127,127,127,0.1)' : 'transparent',
          cursor: 'pointer',
          transition: 'color 140ms ease, background 140ms ease',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 7.2v3.4M8 5.1v.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        // Padding creates a pointer-safe bridge between the icon and panel.
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            width: 'min(440px, calc(100vw - 48px))',
            paddingTop: 10,
            zIndex: 60,
          }}
        >
          <div
            role="dialog"
            aria-label="Strategy explanation"
            className="hs-fade-in"
            style={{
              maxHeight: 'min(480px, calc(100vh - 180px))',
              overflowY: 'auto',
              background: 'var(--surface)',
              border: '1px solid var(--border-chrome)',
              borderRadius: 14,
              boxShadow: 'var(--card-shadow)',
              padding: 16,
              textAlign: 'left',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--muted)',
                }}
              >
                Strategy explanation
              </div>
              <button
                type="button"
                aria-label="Copy strategy explanation"
                title="Copy explanation"
                onClick={() => void copyExplanation()}
                style={{
                  width: 30,
                  height: 30,
                  flex: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '1px solid var(--border-input)',
                  borderRadius: 9,
                  color: toast === 'copied' ? 'var(--green-text)' : 'var(--text)',
                  background: 'var(--bg)',
                  cursor: 'pointer',
                  transition: 'color 140ms ease, border-color 140ms ease',
                }}
              >
                {toast === 'copied' ? (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="m3.5 8.2 2.7 2.7 6.3-6.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <rect x="5.2" y="5.2" width="7.3" height="7.3" rx="1.4" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M3.5 10.6H3A1.5 1.5 0 0 1 1.5 9.1V3A1.5 1.5 0 0 1 3 1.5h6.1A1.5 1.5 0 0 1 10.6 3v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            </div>

            <div style={{ fontSize: 16, fontWeight: 650, color: 'var(--text)', marginTop: 10 }}>
              {name}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text)', marginTop: 5 }}>
              {summary}
            </div>

            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                marginTop: 16,
              }}
            >
              Current implementation
            </div>
            <div
              style={{
                fontSize: 12.5,
                lineHeight: 1.62,
                color: 'var(--muted)',
                marginTop: 6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {details}
            </div>

            <div
              className="num"
              style={{
                marginTop: 14,
                padding: '10px 11px',
                border: '1px solid var(--hairline)',
                borderRadius: 10,
                background: 'var(--bg)',
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text)',
              }}
            >
              <span style={{ color: 'var(--muted)' }}>Presented backtest{versionLabel ? ` · ${versionLabel}` : ''}</span>
              <span style={{ display: 'block', marginTop: 2 }}>{snapshot}</span>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <CopyToast
          tone={toast === 'copied' ? 'success' : 'error'}
          message={toast === 'copied' ? 'Strategy explanation copied' : 'Couldn’t copy explanation'}
        />
      )}
    </div>
  );
}
