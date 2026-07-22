'use client';

// 32px circular gear button (sibling of ThemeToggle in the header) that opens
// a small settings dialog: which model runs the backtests, at what reasoning
// effort, and whether Codex is signed in on this machine.
//
// Selections persist immediately (PUT /api/settings, optimistic with revert on
// failure) — no Save button, matching how the theme control behaves. Settings
// live server-side because the runner consumes them; localStorage would leave
// the container on the old model.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentHealth, AppSettings, CodexEffort } from '@/lib/types';
import { CODEX_EFFORTS, CODEX_MODELS } from '@/lib/types';
import { getAgentHealth, getSettings, updateSettings } from '@/lib/client/api';

// All gpt-5.6 — the user picks the variant; the row shows the variant name
// with the full model id muted beside it.
const MODEL_OPTIONS: { value: (typeof CODEX_MODELS)[number]; label: string; description: string }[] = [
  { value: 'gpt-5.6-sol', label: 'Sol', description: 'gpt-5.6-sol — default' },
  { value: 'gpt-5.6-terra', label: 'Terra', description: 'gpt-5.6-terra' },
  { value: 'gpt-5.6-luna', label: 'Luna', description: 'gpt-5.6-luna' },
];

const EFFORT_LABELS: Record<CodexEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/** Green / red / neutral status dot for the Codex row. */
function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        flex: 'none',
        marginTop: 5,
      }}
    />
  );
}

function CodexStatus({ health }: { health: AgentHealth | null }) {
  if (!health) {
    return <div style={{ fontSize: 13, color: 'var(--muted)' }}>Couldn’t reach the server.</div>;
  }
  if (health.agent === 'mock') {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <Dot color="var(--faint)" />
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--muted)' }}>
          Mock agent active — runs are simulated and Codex isn’t used. Set{' '}
          <code style={{ fontSize: 12 }}>HINDSIGHT_AGENT=codex</code> to run real backtests.
        </div>
      </div>
    );
  }
  if (health.ready) {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <Dot color="var(--green-stroke)" />
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>Signed in</span>
          {health.codexHome ? (
            <div style={{ color: 'var(--muted)', marginTop: 2, wordBreak: 'break-all' }}>
              Credentials from {health.codexHome}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Dot color="var(--red)" />
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <span style={{ color: 'var(--red)', fontWeight: 600 }}>{health.reason ?? 'Not signed in.'}</span>
        {health.hint ? (
          <div style={{ color: 'var(--muted)', marginTop: 2 }}>{health.hint}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function SettingsControl() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  // (Re)load on every open so a `codex login` done meanwhile shows up.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setSaveError(null);
    void Promise.allSettled([getSettings(), getAgentHealth()]).then(([s, h]) => {
      if (cancelled) return;
      if (s.status === 'fulfilled') setSettings(s.value);
      setHealth(h.status === 'fulfilled' ? h.value : null);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    // Capture phase + stopPropagation: Escape here means "close this dialog",
    // and must never reach the page's run-interrupt listener.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  /** Optimistically apply a change; revert and surface the error if PUT fails. */
  const apply = (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...prev, ...patch });
    setSaveError(null);
    updateSettings(patch)
      .then((saved) => setSettings(saved))
      .catch((err: Error) => {
        setSettings(prev);
        setSaveError(err.message || 'Couldn’t save settings.');
      });
  };

  const mockMode = health?.agent === 'mock';

  return (
    <>
      <button
        type="button"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={{
          width: 32,
          height: 32,
          border: '1px solid var(--border-chrome)',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface)',
          flex: 'none',
          touchAction: 'manipulation',
        }}
      >
        {/* Gear, drawn to match the theme toggle's 14px 1.3-stroke icon. */}
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="2.1" fill="none" stroke="var(--icon)" strokeWidth="1.3" />
          <path
            d="M7 1.2v1.6M7 11.2v1.6M1.2 7h1.6M11.2 7h1.6M2.9 2.9l1.13 1.13M9.97 9.97l1.13 1.13M11.1 2.9 9.97 4.03M4.03 9.97 2.9 11.1"
            stroke="var(--icon)"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="var(--icon)" strokeWidth="1.3" strokeDasharray="2.4 1.62" />
        </svg>
      </button>

      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              className="hs-fade-in"
              onClick={close}
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
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="Settings"
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: '100%',
                  maxWidth: 420,
                  background: 'var(--surface)',
                  border: '1px solid var(--border-input)',
                  borderRadius: 'var(--r-card)',
                  boxShadow: 'var(--card-shadow)',
                  padding: '22px 24px 20px',
                  outline: 'none',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 18,
                  }}
                >
                  <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>Settings</div>
                  <button
                    type="button"
                    aria-label="Close settings"
                    onClick={close}
                    style={{
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '50%',
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M2 2l8 8M10 2l-8 8"
                        stroke="var(--icon)"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>

                {!loaded || !settings ? (
                  <div style={{ fontSize: 13, color: 'var(--muted)', padding: '8px 0 16px' }}>
                    {loaded ? 'Couldn’t load settings.' : 'Loading…'}
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: 18 }}>
                      <SectionLabel>Model</SectionLabel>
                      <div role="radiogroup" aria-label="Model">
                        {MODEL_OPTIONS.map((option) => {
                          const active = option.value === settings.model;
                          return (
                            <button
                              key={option.value}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onClick={() => apply({ model: option.value })}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                width: '100%',
                                minHeight: 40,
                                padding: '0 10px',
                                borderRadius: 8,
                                border: 'none',
                                background: active ? 'var(--hairline)' : 'transparent',
                                color: 'var(--text)',
                                fontSize: 14,
                                textAlign: 'left',
                                cursor: 'pointer',
                                touchAction: 'manipulation',
                              }}
                            >
                              <span style={{ flex: 1 }}>{option.label}</span>
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                                {option.description}
                              </span>
                              {active ? (
                                <svg
                                  width="13"
                                  height="13"
                                  viewBox="0 0 14 14"
                                  aria-hidden="true"
                                  style={{ flex: 'none' }}
                                >
                                  <path
                                    d="M2.5 7.4 5.6 10.5 11.5 4"
                                    fill="none"
                                    stroke="var(--text)"
                                    strokeWidth="1.6"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              ) : (
                                <span style={{ width: 13, flex: 'none' }} />
                              )}
                            </button>
                          );
                        })}
                        {!CODEX_MODELS.includes(settings.model as (typeof CODEX_MODELS)[number]) ? (
                          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 10px 0' }}>
                            Currently set to “{settings.model}” (from configuration).
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ marginBottom: 18 }}>
                      <SectionLabel>Reasoning effort</SectionLabel>
                      <div
                        role="radiogroup"
                        aria-label="Reasoning effort"
                        style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}
                      >
                        {CODEX_EFFORTS.map((effort) => {
                          const active = effort === settings.effort;
                          return (
                            <button
                              key={effort}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              onClick={() => apply({ effort })}
                              style={{
                                padding: '6px 12px',
                                borderRadius: 'var(--r-pill)',
                                border: `1px solid ${active ? 'var(--text)' : 'var(--border-input)'}`,
                                background: active ? 'var(--primary-bg)' : 'var(--surface)',
                                color: active ? 'var(--primary-text)' : 'var(--muted)',
                                fontSize: 13,
                                fontWeight: 600,
                                cursor: 'pointer',
                                touchAction: 'manipulation',
                              }}
                            >
                              {EFFORT_LABELS[effort]}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div style={{ marginBottom: 4 }}>
                      <SectionLabel>Codex</SectionLabel>
                      <CodexStatus health={health} />
                    </div>

                    {saveError ? (
                      <div style={{ fontSize: 13, color: 'var(--red)', marginTop: 12 }}>{saveError}</div>
                    ) : null}

                    <div
                      style={{
                        fontSize: 12,
                        lineHeight: 1.5,
                        color: 'var(--muted)',
                        marginTop: 16,
                        paddingTop: 14,
                        borderTop: '1px solid var(--hairline)',
                      }}
                    >
                      Model and effort apply to new strategies and chat refinements
                      {mockMode ? ' (once the Codex agent is enabled)' : ''}. Date-only re-runs reuse
                      the saved code without an LLM.
                    </div>
                  </>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
