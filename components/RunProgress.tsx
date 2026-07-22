'use client';

// Live run progress: pulsing dot + whimsical status word + elapsed timer, the
// streaming step list (✓ done / spinner active), and the "esc to interrupt"
// hint. Fed by SSE `status` and `step` frames.
//
// Two sizes, one implementation. 'hero' is the Working view (screen 02, the
// first backtest, centered 620px column); 'compact' is the same thing echoed at
// the bottom of the chat during a refine/re-run, where an existing result is
// already on screen. They must not drift apart — a run looks like a run.

import type { StatusWord, StepEvent } from '@/lib/types';
import { formatElapsed } from '@/lib/format';

export interface RunProgressProps {
  statusWord: StatusWord;
  elapsedMs: number;
  steps: StepEvent[];
  size?: 'hero' | 'compact';
  /** Muted footer line, e.g. "esc to interrupt". Omit to hide it. */
  hint?: string;
}

const SIZES = {
  hero: { gap: 16, status: 17, step: 14, dot: 8, spinner: 12, stepGap: 10 },
  compact: { gap: 12, status: 15, step: 13, dot: 7, spinner: 11, stepGap: 8 },
} as const;

export default function RunProgress({
  statusWord,
  elapsedMs,
  steps,
  size = 'hero',
  hint,
}: RunProgressProps) {
  const s = SIZES[size];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: s.gap }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          className="hs-pulse"
          style={{
            width: s.dot,
            height: s.dot,
            borderRadius: '50%',
            background: 'var(--green-stroke)',
            flex: 'none',
          }}
        />
        <div style={{ fontSize: s.status, fontWeight: 600, color: 'var(--text)' }}>{statusWord}</div>
        <div className="num" style={{ fontSize: 13, color: 'var(--muted)', marginLeft: 'auto' }}>
          {formatElapsed(elapsedMs)}
        </div>
      </div>

      {steps.length > 0 && (
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: s.stepGap, fontSize: s.step }}
        >
          {steps.map((step) =>
            step.state === 'done' ? (
              <div
                key={step.id}
                className="hs-fade-in"
                style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--muted)' }}
              >
                <span style={{ color: 'var(--green-stroke)' }}>✓</span> {step.label}
              </div>
            ) : (
              <div
                key={step.id}
                className="hs-fade-in"
                style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text)' }}
              >
                <div
                  className="hs-spin"
                  style={{
                    width: s.spinner,
                    height: s.spinner,
                    border: '2px solid var(--spinner-track)',
                    borderTopColor: 'var(--icon)',
                    borderRadius: '50%',
                    flex: 'none',
                  }}
                />
                {step.label}
              </div>
            ),
          )}
        </div>
      )}

      {hint && <div style={{ fontSize: 12, color: 'var(--faint)' }}>{hint}</div>}
    </div>
  );
}
