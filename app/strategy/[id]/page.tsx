'use client';

// Strategy page. status 'running' with no result yet → WorkingView (screen 02,
// plain header per the design); otherwise → ExpandedView (screen 03, header
// with back link + hairline). During an active re-run (running WITH an
// existing result) the ExpandedView chart shimmers, the Period controls are
// disabled, and the SAME live progress the Working view shows (status word,
// elapsed, steps) trails the chat. On 'result'/'done'/'error' the session is
// refetched; run errors surface as agent chat messages appended by the backend.

import { use, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentResponseMetadata,
  ChatMessage,
  Period,
  StatusWord,
  StepEvent,
} from '@/lib/types';
import { interrupt, refine, rerun } from '@/lib/client/api';
import { useSession } from '@/lib/client/useSession';
import { useSSE } from '@/lib/client/useSSE';
import Header from '@/components/Header';
import WorkingView from '@/components/WorkingView';
import ExpandedView from '@/components/ExpandedView';

export default function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { session, error, refetch, applySession, applyMeta } = useSession(id);

  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [statusWord, setStatusWord] = useState<StatusWord>('Tinkering…');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [liveMessages, setLiveMessages] = useState<ChatMessage[]>([]);
  const [runActive, setRunActive] = useState(false);
  const liveIdRef = useRef(0);

  const appendLive = (
    role: 'agent' | 'system',
    text: string,
    metadata?: AgentResponseMetadata,
  ) => {
    liveIdRef.current += 1;
    const message: ChatMessage = {
      id: `live-${liveIdRef.current}`,
      role,
      text,
      ...(metadata ? { metadata } : {}),
      createdAt: Date.now(),
    };
    setLiveMessages((prev) => [...prev, message]);
  };

  useSSE(id, {
    onSnapshot: (snap) => {
      setSteps(snap.steps);
      setRunActive(snap.active);
      if (snap.status_line) {
        setStatusWord(snap.status_line.label);
        setElapsedMs(snap.status_line.elapsedMs);
      }
      // The snapshot carries authoritative run status. If the server says the
      // run is no longer active while this client still believes one is live
      // (late-join / reconnect after the terminal frames were already sent),
      // pull the now-terminal session so the view leaves the WorkingView /
      // re-running state instead of hanging there forever.
      const clientThinksRunning =
        session?.status === 'running' || session?.result === null || runActive;
      if ((!snap.active || snap.status !== 'running') && clientThinksRunning) {
        void refetch();
      }
    },
    onStatus: (e) => {
      setRunActive(true);
      setStatusWord(e.label);
      setElapsedMs(e.elapsedMs);
    },
    onStep: (e) => {
      setSteps((prev) => {
        const index = prev.findIndex((s) => s.id === e.id);
        if (index === -1) return [...prev, e];
        const next = prev.slice();
        next[index] = e;
        return next;
      });
    },
    onMeta: (e) => applyMeta(e.name, e.description),
    onMessage: (e) => appendLive(e.role, e.text, e.metadata),
    onResult: () => {
      void refetch();
    },
    onError: () => {
      setRunActive(false);
      void refetch();
    },
    onDone: () => {
      setRunActive(false);
      void refetch();
    },
  });

  const handleInterrupt = async () => {
    try {
      await interrupt(id);
    } catch {
      // The run may already be over; the refetch below sorts out the truth.
    }
    await refetch();
  };

  // Clear the previous run's progress and show a live status line immediately —
  // the POST that starts the run takes a moment, and step ids repeat between
  // runs ("data", "backtest"), so stale ✓ rows would otherwise carry over and
  // read as instant progress on the new run.
  const beginRun = () => {
    setSteps([]);
    setStatusWord('Tinkering…');
    setElapsedMs(0);
    setRunActive(true);
    // Drop live-only messages from before this run (e.g. an old "Could not
    // send" note) — otherwise they render pinned below newer persisted chat.
    setLiveMessages([]);
  };

  /** The run never started; drop back out of the running state. */
  const failRun = (e: unknown, fallback: string) => {
    setRunActive(false);
    appendLive('system', e instanceof Error ? e.message : fallback);
  };

  const handleRefine = async (text: string, images: File[]) => {
    beginRun();
    try {
      applySession(await refine(id, text, images));
    } catch (e) {
      failRun(e, 'Could not send the refinement.');
    }
  };

  const handleRerun = async (period: Period) => {
    beginRun();
    try {
      applySession(await rerun(id, { period }));
    } catch (e) {
      failRun(e, 'Could not start the re-run.');
    }
  };

  const handleRefresh = async () => {
    beginRun();
    try {
      applySession(await rerun(id, { refreshData: true }));
    } catch (e) {
      failRun(e, 'Could not refresh the data.');
    }
  };

  // Attachments on the most recent user turn — what this run was given.
  const lastUserAttachments = useMemo(() => {
    if (!session) return undefined;
    for (let i = session.chat.length - 1; i >= 0; i--) {
      const m = session.chat[i];
      if (m.role === 'user') return m.attachments;
    }
    return undefined;
  }, [session]);

  // Tab title carries the strategy name once the agent has named it ('' until
  // the meta event lands, and on a fresh session before the first run). This is
  // a client component, so there is no metadata export to do it — set it here
  // and restore the plain title on the way out.
  const name = session?.name ?? '';
  useEffect(() => {
    document.title = name ? `Hindsight - ${name}` : 'Hindsight';
    return () => {
      document.title = 'Hindsight';
    };
  }, [name]);

  const working = session !== null && session.status === 'running' && session.result === null;
  const isRerunning =
    session !== null && session.result !== null && (session.status === 'running' || runActive);

  // A re-run keeps the ExpandedView on screen (shimmering, controls disabled),
  // so mirror the WorkingView's "esc to interrupt" affordance here — otherwise
  // there is no way to cancel a refine/rerun. Same handler, same POST + refetch.
  const interruptRef = useRef(handleInterrupt);
  interruptRef.current = handleInterrupt;
  useEffect(() => {
    if (!isRerunning) return;
    const onKey = (e: KeyboardEvent) => {
      // defaultPrevented ⇒ an open popover/dialog consumed this Escape to
      // close itself; don't also kill the run.
      if (e.key === 'Escape' && !e.defaultPrevented) void interruptRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isRerunning]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header variant={session === null || working ? 'plain' : 'withBack'} />
      {session === null ? (
        error ? (
          <div
            className="hs-fade-in"
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingBottom: 72,
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            {error}
          </div>
        ) : (
          <div style={{ flex: 1 }} />
        )
      ) : working ? (
        <WorkingView
          sessionId={session.id}
          prompt={session.prompt}
          // Images attached to the turn that started this run — the opening
          // prompt for a first run, the latest refinement otherwise.
          attachments={lastUserAttachments}
          steps={steps}
          statusWord={statusWord}
          elapsedMs={elapsedMs}
          onInterrupt={() => void handleInterrupt()}
        />
      ) : (
        <ExpandedView
          session={session}
          liveMessages={liveMessages}
          isRerunning={isRerunning}
          run={isRerunning ? { statusWord, elapsedMs, steps } : null}
          onRefine={(text, images) => void handleRefine(text, images)}
          onRerun={(period) => void handleRerun(period)}
          onRefresh={() => void handleRefresh()}
          onSessionChange={applySession}
        />
      )}
    </div>
  );
}
