'use client';

// ============================================================================
// useSSE — subscribe to a session's progress stream (PROTOCOL.md §7).
// Opens EventSource('/api/sessions/<id>/stream') and dispatches the named
// frames (snapshot/status/step/meta/message/result/error/done) to handlers.
// Cleans up on unmount and reconnects if the connection drops — quickly while
// a run is active, lazily when idle. Handlers are kept in a ref, so passing a
// fresh object every render is fine and does not reopen the stream.
//
// Note on 'error': the server sends `event: error` frames WITH data, while the
// browser also fires data-less 'error' events for connection problems. We
// branch on the presence of parseable data.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
import type {
  DoneEvent,
  ErrorEvent as StreamErrorEvent,
  MessageEvent as StreamMessageEvent,
  MetaEvent,
  ResultEvent,
  RunSnapshot,
  StatusEvent,
  StepEvent,
} from '@/lib/types';

export interface SSEHandlers {
  onSnapshot?: (snapshot: RunSnapshot) => void;
  onStatus?: (event: StatusEvent) => void;
  onStep?: (event: StepEvent) => void;
  onMeta?: (event: MetaEvent) => void;
  onMessage?: (event: StreamMessageEvent) => void;
  onResult?: (event: ResultEvent) => void;
  onError?: (event: StreamErrorEvent) => void;
  onDone?: (event: DoneEvent) => void;
}

export type SSEConnectionStatus = 'connecting' | 'open' | 'closed';

const RETRY_DELAY_MS = 1500;
/** Slower cadence for reconnecting while no run is active. */
const IDLE_RETRY_DELAY_MS = 5000;

/** Parse the JSON payload of an SSE frame; undefined for connection events. */
function parseData(raw: Event): unknown {
  const data = (raw as unknown as { data?: unknown }).data;
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

export function useSSE(sessionId: string | null | undefined, handlers: SSEHandlers): SSEConnectionStatus {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [status, setStatus] = useState<SSEConnectionStatus>(sessionId ? 'connecting' : 'closed');

  useEffect(() => {
    if (!sessionId) {
      setStatus('closed');
      return;
    }

    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    /** True while a run is in flight (from snapshot/status frames). */
    let runActive = false;

    const connect = () => {
      if (disposed) return;
      es?.close();
      setStatus('connecting');
      es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);

      es.addEventListener('open', () => {
        if (!disposed) setStatus('open');
      });

      es.addEventListener('snapshot', (raw) => {
        const snap = parseData(raw) as RunSnapshot | undefined;
        if (!snap) return;
        runActive = snap.active;
        handlersRef.current.onSnapshot?.(snap);
      });

      es.addEventListener('status', (raw) => {
        const event = parseData(raw) as StatusEvent | undefined;
        if (!event) return;
        runActive = true;
        handlersRef.current.onStatus?.(event);
      });

      es.addEventListener('step', (raw) => {
        const event = parseData(raw) as StepEvent | undefined;
        if (!event) return;
        handlersRef.current.onStep?.(event);
      });

      es.addEventListener('meta', (raw) => {
        const event = parseData(raw) as MetaEvent | undefined;
        if (!event) return;
        handlersRef.current.onMeta?.(event);
      });

      es.addEventListener('message', (raw) => {
        const event = parseData(raw) as StreamMessageEvent | undefined;
        if (!event) return;
        handlersRef.current.onMessage?.(event);
      });

      es.addEventListener('result', (raw) => {
        const event = parseData(raw) as ResultEvent | undefined;
        if (!event) return;
        handlersRef.current.onResult?.(event);
      });

      es.addEventListener('done', (raw) => {
        runActive = false;
        const event = (parseData(raw) as DoneEvent | undefined) ?? { type: 'done' as const };
        handlersRef.current.onDone?.(event);
      });

      es.addEventListener('error', (raw) => {
        const payload = parseData(raw) as StreamErrorEvent | undefined;
        if (payload && payload.type === 'error') {
          // Server-sent error frame: the run failed.
          runActive = false;
          handlersRef.current.onError?.(payload);
          return;
        }
        // Connection-level problem.
        if (disposed) return;
        if (es && es.readyState === EventSource.CLOSED) {
          setStatus('closed');
          // Always reconnect — just more lazily when idle. A stream that dies
          // while no run is active (server restart, transient non-200) must
          // not go permanently silent: the next run would then execute blind,
          // with no frames and no run-end refetch.
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = setTimeout(connect, runActive ? RETRY_DELAY_MS : IDLE_RETRY_DELAY_MS);
        } else {
          // Browser is auto-reconnecting.
          setStatus('connecting');
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
    };
  }, [sessionId]);

  return status;
}
