'use client';

// Home. No sessions (and not composing) → Empty state (screen 01) with the
// composer. One or more sessions → Strategy List (screen 04); "+ New" and
// "＋ New strategy" switch to the composer. Submitting creates a session and
// navigates to its strategy page.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentHealth, Session } from '@/lib/types';
import { createSession, getAgentHealth, listSessions } from '@/lib/client/api';
import Header from '@/components/Header';
import EmptyComposer from '@/components/EmptyComposer';
import StrategyList from '@/components/StrategyList';

// Module-level cache of the last successful sessions list. Seeding useState
// from it means back-nav renders the prior list/composer immediately instead
// of a blank, non-interactive spacer that would swallow the first click.
let sessionsCache: Session[] | null = null;

export default function HomePage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[] | null>(sessionsCache);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<AgentHealth | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await listSessions();
      sessionsCache = list;
      setSessions(list);
    } catch {
      // Keep whatever we had; first failure falls back to an empty list.
      setSessions((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Agent readiness (in codex mode: are there Codex credentials on the host?).
  // Re-checked on window focus so signing in from a terminal unblocks the
  // composer on the next tab switch, without a reload.
  useEffect(() => {
    const check = async () => {
      try {
        setHealth(await getAgentHealth());
      } catch {
        // Health endpoint unreachable — don't invent a block; the create call
        // still reports the truth if something is actually wrong.
        setHealth(null);
      }
    };
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // While any backtest is still running, keep the list rows fresh. Drive the
  // poll off a stable boolean so the interval is created once (not torn down
  // and recreated every 3s when load() swaps in a fresh array identity).
  const anyRunning = sessions?.some((s) => s.status === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  const handleSubmit = async (prompt: string, images: File[]) => {
    setBusy(true);
    setError(null);
    try {
      const session = await createSession({ prompt }, images);
      router.push(`/strategy/${session.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const showComposer = composing || (sessions !== null && sessions.length === 0);
  // Only offer a way back when there IS a list behind the composer — on a truly
  // empty install the composer is the whole app.
  const canLeaveComposer = composing && !!sessions?.length;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header
        variant="plain"
        onBack={canLeaveComposer ? () => setComposing(false) : undefined}
      />
      {sessions === null ? (
        <div style={{ flex: 1 }} />
      ) : showComposer ? (
        <EmptyComposer
          onSubmit={handleSubmit}
          busy={busy}
          errorText={error}
          blockedReason={health && !health.ready ? health.reason : null}
          blockedHint={health && !health.ready ? health.hint : null}
        />
      ) : (
        <StrategyList
          sessions={sessions}
          onNew={() => setComposing(true)}
          onDeleted={() => void load()}
        />
      )}
    </div>
  );
}
