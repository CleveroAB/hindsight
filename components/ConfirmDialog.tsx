'use client';

// On-theme confirmation modal. Used for destructive actions (deleting a
// strategy), where a native window.confirm() would break out of the app's
// visual language and can't say "Deleting…" while the request is in flight.
//
// Escape and a click on the scrim cancel; the confirm button takes focus on
// open, so Enter confirms and Tab stays inside the dialog.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  title: string;
  /** Supporting line under the title. */
  body?: string;
  confirmLabel: string;
  /** Replaces the confirm label while `busy` (e.g. "Deleting…"). */
  busyLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
  /** True while the confirmed action is running — buttons lock, label changes. */
  busy?: boolean;
  /** Shown in place of the body when the action failed. */
  errorText?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busyLabel,
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  errorText = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase + stopPropagation: Escape here means "dismiss this
      // dialog", and must never reach the page's run-interrupt listener.
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      // Minimal focus trap: Tab cycles between the two buttons instead of
      // walking into the obscured page behind the scrim.
      if (e.key === 'Tab') {
        e.preventDefault();
        const next = document.activeElement === confirmRef.current ? cancelRef.current : confirmRef.current;
        next?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="hs-fade-in"
      onClick={() => {
        if (!busy) onCancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.42)',
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 380,
          background: 'var(--surface)',
          border: '1px solid var(--border-input)',
          borderRadius: 'var(--r-card)',
          boxShadow: 'var(--card-shadow)',
          padding: '22px 24px 18px',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
        {(errorText || body) && (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.5,
              marginTop: 8,
              color: errorText ? 'var(--red)' : 'var(--muted)',
            }}
          >
            {errorText || body}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            marginTop: 20,
          }}
        >
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              border: '1px solid var(--border-input)',
              background: 'var(--surface)',
              color: 'var(--muted)',
              borderRadius: 'var(--r-pill)',
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              opacity: busy ? 0.55 : 1,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            style={{
              background: danger ? 'var(--red)' : 'var(--primary-bg)',
              color: danger ? '#FFFFFF' : 'var(--primary-text)',
              borderRadius: 'var(--r-pill)',
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              opacity: busy ? 0.65 : 1,
              cursor: busy ? 'default' : 'pointer',
            }}
          >
            {busy ? busyLabel ?? `${confirmLabel}…` : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
