'use client';

// ============================================================================
// useSession — load a Session by id and keep it in client state.
// Exposes refetch() plus small mergers for live SSE updates:
//   applyMeta(name, description)  — from a 'meta' frame
//   applyResult(result)           — from a 'result' frame
//   applySession(session)         — replace wholesale (e.g. a POST response)
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, StrategyResult } from '@/lib/types';
import { getSession } from './api';

/** Backoff before the single refetch retry (transient localhost blip). */
const REFETCH_RETRY_MS = 1200;

export interface UseSessionState {
  session: Session | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  applySession: (session: Session) => void;
  applyMeta: (name: string, description: string) => void;
  applyResult: (result: StrategyResult) => void;
}

export function useSession(id: string | null | undefined): UseSessionState {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(id));
  const [error, setError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Monotonic sequence for request ordering: only the LATEST refetch (or a
  // direct applySession) may write state. Without this, a slow in-flight
  // response from mid-run can land after the run-end refetch and revert the
  // session to 'running' — permanently, since no further SSE frame refetches.
  const seqRef = useRef(0);

  const refetch = useCallback(async () => {
    if (!id) return;
    const seq = ++seqRef.current;
    const stale = () => !aliveRef.current || seq !== seqRef.current;
    // A single transient failure at run end must not permanently pin a stale
    // 'running' session (which alone keeps the UI shimmering with controls
    // disabled, since the SSE stream won't re-trigger a refetch). Retry once
    // before surfacing the error so a momentary localhost blip self-heals.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fresh = await getSession(id);
        if (stale()) return;
        setSession(fresh);
        setError(null);
        setLoading(false);
        return;
      } catch (e) {
        if (stale()) return;
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, REFETCH_RETRY_MS));
          if (stale()) return;
          continue;
        }
        setError(e instanceof Error ? e.message : 'Failed to load the session.');
        setLoading(false);
      }
    }
  }, [id]);

  useEffect(() => {
    setSession(null);
    setError(null);
    setLoading(Boolean(id));
    void refetch();
  }, [id, refetch]);

  const applySession = useCallback((next: Session) => {
    // A fresh authoritative session (e.g. a POST response) also invalidates
    // any refetch still in flight, so a stale read can't overwrite it.
    seqRef.current += 1;
    setSession(next);
  }, []);

  const applyMeta = useCallback((name: string, description: string) => {
    setSession((prev) => (prev ? { ...prev, name, description } : prev));
  }, []);

  const applyResult = useCallback((result: StrategyResult) => {
    setSession((prev) => (prev ? { ...prev, result } : prev));
  }, []);

  return { session, loading, error, refetch, applySession, applyMeta, applyResult };
}
