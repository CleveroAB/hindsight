'use client';

// Screen 01 — the empty-state composer. Heading, 640px prompt box with an
// auto-growing textarea, "⏎ to run" hint + circular primary-invert send
// button, and the caption. Enter submits; Shift+Enter inserts a newline.
//
// Images can be attached here the same way as in the chat (paperclip, paste, or
// drop) — a strategy is often easiest to state by showing a chart.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useImageDrafts } from '@/lib/client/useImageDrafts';
import AttachButton from './AttachButton';
import ImageDraftStrip from './ImageDraftStrip';

const PLACEHOLDER =
  'Describe a strategy and a period. “Buy QQQ when RSI dips below 30, sell above 70, 2016–2025.”';
const BLOCKED_PLACEHOLDER = 'Backtests are unavailable until the agent can sign in.';

export interface EmptyComposerProps {
  onSubmit: (prompt: string, images: File[]) => void;
  /** Disables submission while a create request is in flight. */
  busy?: boolean;
  /** Quiet error line shown under the prompt box, if a submit failed. */
  errorText?: string | null;
  /**
   * Set when the agent can't run at all (e.g. Codex isn't signed in on the
   * host). Shows a notice in place of the "⏎ to run" hint and locks the
   * textarea + send button — there is nothing a prompt could do.
   */
  blockedReason?: string | null;
  /** How to unblock, shown under the reason. */
  blockedHint?: string | null;
}

export default function EmptyComposer({
  onSubmit,
  busy = false,
  errorText = null,
  blockedReason = null,
  blockedHint = null,
}: EmptyComposerProps) {
  const blocked = blockedReason !== null;
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const images = useImageDrafts(blocked || busy);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resize();
    if (!blocked) textareaRef.current?.focus();
  }, [resize, blocked]);

  const submit = () => {
    const prompt = value.trim();
    // Unlike the chat, a strategy needs words: an image alone doesn't say what
    // period to test or what to do with what it shows.
    if (!prompt || busy || blocked) return;
    // Deliberately NOT clearing the drafts: a failed create leaves this
    // composer on screen, and re-picking the images would be infuriating. A
    // successful one navigates away, and unmount revokes the previews.
    onSubmit(prompt, images.drafts.map((d) => d.file));
  };

  const canSubmit = value.trim().length > 0 && !busy && !blocked;

  return (
    <div
      className="hs-fade-in"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 32,
        paddingBottom: 72,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <style>{`.hs-composer-ta::placeholder{color:var(--muted);opacity:1;}`}</style>
      <h1
        style={{
          fontSize: 42,
          fontWeight: 700,
          letterSpacing: '-0.03em',
          color: 'var(--text)',
          textAlign: 'center',
          margin: 0,
        }}
      >
        Would it have worked?
      </h1>
      <div
        style={{
          width: '100%',
          maxWidth: 640,
          background: 'var(--surface)',
          border: '1px solid var(--border-input)',
          borderRadius: 'var(--r-prompt)',
          boxShadow: 'var(--card-shadow)',
          padding: '20px 20px 14px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
        onDragOver={images.onDragOver}
        onDrop={images.onDrop}
      >
        <textarea
          ref={textareaRef}
          className="hs-composer-ta"
          value={value}
          placeholder={blocked ? BLOCKED_PLACEHOLDER : PLACEHOLDER}
          rows={2}
          disabled={blocked}
          aria-disabled={blocked}
          title="Enter to run · Shift+Enter for a new line"
          onChange={(e) => {
            setValue(e.target.value);
            resize();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          // Pasting a screenshot of a chart is the fastest way to describe one.
          onPaste={images.onPaste}
          style={{
            width: '100%',
            minHeight: 52,
            border: 'none',
            outline: 'none',
            resize: 'none',
            overflow: 'hidden',
            background: 'transparent',
            fontSize: 16,
            lineHeight: 1.55,
            color: blocked ? 'var(--muted)' : 'var(--text)',
            padding: 0,
            margin: 0,
            cursor: blocked ? 'not-allowed' : 'text',
            // Only while blocked: undo the UA's grey-out of a disabled field.
            // Setting it unconditionally would also override ::placeholder's
            // colour (WebKit applies text-fill-color to the placeholder too),
            // rendering the hint as full-strength body text.
            ...(blocked ? { WebkitTextFillColor: 'var(--muted)' } : null),
          }}
        />
        <ImageDraftStrip drafts={images.drafts} onRemove={images.remove} size={64} />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <AttachButton onFiles={images.addFiles} disabled={blocked} size={28} />
          {blocked ? (
            <div style={{ fontSize: 12, color: 'var(--red)', lineHeight: 1.5 }}>{blockedReason}</div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--faint)' }}>
              Enter to run · Shift+Enter for a new line
            </div>
          )}
          <button
            type="button"
            aria-label="Run backtest"
            onClick={submit}
            disabled={!canSubmit}
            style={{
              marginLeft: 'auto',
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: 'var(--primary-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
              opacity: canSubmit ? 1 : 0.55,
              cursor: canSubmit ? 'pointer' : 'default',
              transition: 'opacity 150ms ease',
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 19V6M6 12l6-6 6 6"
                stroke="var(--primary-text)"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {blocked && blockedHint ? (
        <div
          className="hs-fade-in"
          style={{ fontSize: 13, color: 'var(--muted)', marginTop: -18, textAlign: 'center', maxWidth: 640 }}
        >
          {blockedHint}
        </div>
      ) : null}
      {errorText ? (
        <div className="hs-fade-in" style={{ fontSize: 13, color: 'var(--red)', marginTop: -18 }}>
          {errorText}
        </div>
      ) : null}
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>Historical data only. Nothing is traded.</div>
    </div>
  );
}
