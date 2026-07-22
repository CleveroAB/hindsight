'use client';

// Screen 02 — the agent-working view. Centered 620px column: the submitted
// prompt in a quiet card (with any images attached to it), the pulsing status
// row (whimsical word + live elapsed), the streaming step list, and "esc to
// interrupt". The status word and elapsed time come from live SSE 'status' frames.

import { useEffect, useRef } from 'react';
import type { Attachment, StatusWord, StepEvent } from '@/lib/types';
import AttachmentGallery from './AttachmentGallery';
import RunProgress from './RunProgress';

export interface WorkingViewProps {
  /** Owning session — needed to resolve attachment URLs. */
  sessionId: string;
  prompt: string;
  /** Images sent with the prompt; shown as thumbnails under it. */
  attachments?: Attachment[];
  steps: StepEvent[];
  statusWord: StatusWord;
  elapsedMs: number;
  onInterrupt: () => void;
}

export default function WorkingView({
  sessionId,
  prompt,
  attachments,
  steps,
  statusWord,
  elapsedMs,
  onInterrupt,
}: WorkingViewProps) {
  const onInterruptRef = useRef(onInterrupt);
  onInterruptRef.current = onInterrupt;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // defaultPrevented ⇒ an open popover/dialog consumed this Escape to
      // close itself; don't also kill the run.
      if (e.key === 'Escape' && !e.defaultPrevented) onInterruptRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="hs-fade-in"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        paddingBottom: 72,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 620,
          border: '1px solid var(--border-chrome)',
          background: 'var(--surface)',
          borderRadius: 'var(--r-card)',
          padding: '16px 20px',
          fontSize: 15,
          lineHeight: 1.55,
          color: 'var(--text)',
        }}
      >
        <div style={{ whiteSpace: 'pre-wrap' }}>{prompt}</div>
        {(attachments?.length ?? 0) > 0 && (
          <div style={{ marginTop: 12 }}>
            <AttachmentGallery
              sessionId={sessionId}
              attachments={attachments}
              layout="fixed"
              size={72}
            />
          </div>
        )}
      </div>

      <div style={{ width: '100%', maxWidth: 620, padding: '8px 20px' }}>
        <RunProgress
          statusWord={statusWord}
          elapsedMs={elapsedMs}
          steps={steps}
          size="hero"
          hint="esc to interrupt"
        />
      </div>
    </div>
  );
}
