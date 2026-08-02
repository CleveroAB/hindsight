// ============================================================================
// Signal scheduler — the process-wide singleton that owns scheduled checks for
// ACTIVATED strategies (Session.activation). One `setTimeout` armed at the
// earliest nextCheckAt across all sessions (past-due fires ~15s out), plus a
// 5-minute safety rescan; checks run strictly one at a time off a serial
// queue. Sessions with a live backtest run are skipped and retried — the run
// manager heartbeats its in-memory session while a run is active, and session
// JSON is whole-file last-writer-wins, so writing during a run would clobber
// it. Every tick catches its own errors; the scheduler never dies.
// State pins to globalThis (runManager precedent) so dev HMR doesn't spawn
// rival schedulers, and all timers are unref()d.
// ============================================================================

import { nanoid } from 'nanoid';
import type { SignalUpdate } from '@/lib/types';
import { runManager } from '@/lib/server/runManager';
import * as store from '@/lib/server/store';
import { deriveCadence, nextCheckTime } from './cadence';
import { evaluateSignals, type SignalEvaluation } from './evaluate';
import {
  composeErrorMessage,
  composeFirstCheckMessage,
  composeNoNewBarMessage,
  composeSignalMessage,
  sendSignalMessage,
} from './messenger';

/** Delay for checks already past due when the timer is armed (boot, poke). */
const PAST_DUE_DELAY_MS = 15_000;
/** Retry delay when a session is busy (live run / check already running). */
const BUSY_RETRY_MS = 2 * 60 * 1000;
/** Safety rescan: catches activations the single timer somehow missed. */
const RESCAN_MS = 5 * 60 * 1000;
/** Timer ceiling — the rescan re-arms long horizons well before this expires. */
const MAX_ARM_DELAY_MS = 6 * 60 * 60 * 1000;

export interface SignalScheduler {
  /** Arm the timer + start the safety rescan. Idempotent. */
  init(): void;
  /** Re-arm after any activation change (the activate/deactivate routes call this). */
  poke(): void;
  /**
   * Run one session's check immediately on the same serial queue ("Check
   * now"). Unlike scheduled ticks it ALWAYS sends the resulting update
   * message (HOLD included) and rejects on failure instead of only recording
   * `lastError`. Resolves null when there was no new bar.
   */
  checkNow(sessionId: string): Promise<SignalUpdate | null>;
}

function logError(context: string, err: unknown): void {
  console.error(`[hindsight] ${context}`, err);
}

/** Turn a rejection into a short human-readable error string. */
function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: string };
    if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  }
  const s = String(err);
  return s && s !== '[object Object]' ? s : 'The signal check failed.';
}

function createSignalScheduler(): SignalScheduler {
  let initialized = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Serial queue: at most one check runs at any moment, manual or scheduled. */
  let queue: Promise<unknown> = Promise.resolve();
  const checking = new Set<string>();
  /**
   * In-memory deferrals for busy sessions. Kept OFF disk on purpose: bumping
   * nextCheckAt on the session while a run heartbeats it would race the run
   * manager's writes.
   */
  const deferredUntil = new Map<string, number>();
  /** Manual checks queued or running, by session — dedup happens BEFORE enqueue. */
  const queuedManual = new Set<string>();
  /** Cap on queued manual checks so a flood can't starve scheduled ones. */
  const MAX_QUEUED_MANUAL = 8;

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = queue.then(job, job);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Effective due time for a session: persisted nextCheckAt or a live deferral. */
  function dueAt(sessionId: string, nextCheckAt: number): number {
    return Math.max(nextCheckAt, deferredUntil.get(sessionId) ?? 0);
  }

  async function armAsync(): Promise<void> {
    const sessions = await store.listSessions();
    const now = Date.now();
    let earliest = Infinity;
    for (const session of sessions) {
      if (!session.activation) continue;
      earliest = Math.min(earliest, dueAt(session.id, session.activation.nextCheckAt));
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!Number.isFinite(earliest)) return; // nothing activated
    const delay = earliest <= now ? PAST_DUE_DELAY_MS : Math.min(earliest - now, MAX_ARM_DELAY_MS);
    timer = setTimeout(fire, delay);
    // Never hold the process open just for a scheduled check.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function arm(): void {
    void armAsync().catch((err) => logError('signal scheduler arm failed', err));
  }

  /**
   * Timer callback: run every due session's check serially, then re-arm. Each
   * check takes its own queue slot (rather than one slot for the whole sweep)
   * so a manual "Check now" waits behind at most one in-flight check, not an
   * entire multi-session pass of up-to-5-minute docker runs.
   */
  function fire(): void {
    void (async () => {
      const sessions = await store.listSessions();
      const now = Date.now();
      for (const session of sessions) {
        if (!session.activation) continue;
        if (dueAt(session.id, session.activation.nextCheckAt) > now) continue;
        try {
          await enqueue(() => checkSession(session.id, false));
        } catch (err) {
          logError(`signal check failed for ${session.id}`, err);
        }
      }
    })()
      .catch((err) => logError('signal sweep failed', err))
      .finally(() => arm());
  }

  /**
   * The one code path for a check, scheduled and manual alike: re-read the
   * session, evaluate, re-read again, persist bookkeeping, apply the messaging
   * policy. Scheduled busy/raced ticks defer silently; manual ones throw so
   * the route can explain.
   */
  async function checkSession(sessionId: string, manual: boolean): Promise<SignalUpdate | null> {
    if (checking.has(sessionId)) {
      if (manual) throw new Error('A signal check is already running for this strategy.');
      deferredUntil.set(sessionId, Date.now() + BUSY_RETRY_MS);
      return null;
    }
    const before = await store.getSession(sessionId);
    if (!before?.activation) {
      deferredUntil.delete(sessionId);
      if (manual) throw new Error('This strategy is not activated.');
      return null;
    }
    if (runManager.isActive(sessionId) || before.status === 'running') {
      if (manual) throw new Error('A backtest run is in flight — try again when it finishes.');
      deferredUntil.set(sessionId, Date.now() + BUSY_RETRY_MS);
      return null;
    }

    checking.add(sessionId);
    try {
      deferredUntil.delete(sessionId);
      let evaluation: SignalEvaluation | null = null;
      let checkError: string | null = null;
      try {
        evaluation = await evaluateSignals(before);
      } catch (err) {
        checkError = errorText(err);
      }

      // Re-read: chat or activation may have changed during a long re-run.
      const session = await store.getSession(sessionId);
      if (!session?.activation) {
        // Deactivated or deleted mid-check — nothing to record.
        if (manual && checkError) throw new Error(checkError);
        return evaluation?.update ?? null;
      }
      if (runManager.isActive(sessionId) || session.status === 'running') {
        // A run started mid-check. Its heartbeat owns the session file now, so
        // drop the whole tick (no save, no message) and retry later.
        deferredUntil.set(sessionId, Date.now() + BUSY_RETRY_MS);
        if (manual) throw new Error('A backtest run started during the check — nothing was recorded.');
        return null;
      }

      const activation = session.activation;
      const update = evaluation?.update ?? null;
      // "First check" = no signal recorded yet, so a failed first attempt still
      // gets its holdings confirmation on the next successful one.
      const firstCheck = activation.lastSignal === null;
      const hadError = activation.lastError !== null;

      // Messaging policy (decided before bookkeeping mutates the state):
      //   error  — only on the null→error transition (one notice, no spam);
      //   update — first check: confirmation incl. holdings; manual: always;
      //            scheduled: only when something changed (HOLD stays silent);
      //   noNewBar — scheduled: nothing at all (weekend/holiday: update is
      //            null); manual: restate the state — "Check now" must always
      //            deliver something so the button demonstrably works.
      let text: string | null = null;
      if (checkError) {
        if (!hadError) text = composeErrorMessage(session.name, checkError);
      } else if (update) {
        if (firstCheck) {
          text = composeFirstCheckMessage(
            session.name,
            update,
            evaluation?.latestWeights ?? null,
            evaluation?.latestValue ?? null,
          );
        } else if (manual || update.changes.length > 0) {
          text = composeSignalMessage(session.name, update);
        }
      } else if (manual) {
        text = composeNoNewBarMessage(session.name, activation.lastSignal);
      }

      let sent = false;
      if (text) {
        try {
          await sendSignalMessage(activation.phone, text);
          sent = true;
        } catch (err) {
          // Delivery failures surface exactly like check failures.
          checkError = checkError ?? errorText(err);
        }
      }

      // Re-read AFTER the send: osascript can take up to 15s, and session JSON
      // is whole-file last-writer-wins — writing the pre-send object would
      // resurrect a concurrent deactivation, revert a re-activation's new
      // phone, or clobber a run that started while the message was in flight.
      const now = Date.now();
      const fresh = await store.getSession(sessionId);
      const freshActivation = fresh?.activation ?? null;
      if (!fresh || !freshActivation) {
        // Deactivated or deleted mid-send — nothing to record.
        deferredUntil.delete(sessionId);
      } else if (
        freshActivation.activatedAt !== activation.activatedAt ||
        runManager.isActive(sessionId) ||
        fresh.status === 'running'
      ) {
        // Re-activated as a new subscription, or a run owns the file now —
        // leave it alone and retry on the usual busy delay.
        deferredUntil.set(sessionId, Date.now() + BUSY_RETRY_MS);
      } else {
        freshActivation.lastCheckAt = now;
        freshActivation.lastError = checkError;
        if (update) freshActivation.lastSignal = update;
        const { assetClass } = deriveCadence(fresh);
        freshActivation.nextCheckAt = nextCheckTime(
          freshActivation.cadence,
          assetClass,
          new Date(now),
        ).getTime();
        try {
          await store.saveSession(fresh);
        } catch (err) {
          // Bookkeeping didn't land: the on-disk nextCheckAt is still past
          // due, so without an in-memory deferral the scheduler would re-check
          // (and re-send the identical message) every PAST_DUE_DELAY_MS. Defer
          // to the slot just computed instead. Skip appendChat too — it saves
          // through the same store and would fail identically.
          deferredUntil.set(sessionId, freshActivation.nextCheckAt);
          logError(`signal bookkeeping save failed for ${sessionId}`, err);
          if (manual) throw err;
          return update;
        }
      }

      // Keep in-app history for every message that actually went out — unless
      // a run became active while sending (its heartbeat owns the file now).
      if (sent && text && !runManager.isActive(sessionId)) {
        await store.appendChat(sessionId, {
          id: nanoid(),
          role: 'system',
          text,
          createdAt: Date.now(),
        });
      }

      if (manual && checkError) throw new Error(checkError);
      return update;
    } finally {
      checking.delete(sessionId);
    }
  }

  function init(): void {
    if (initialized) return;
    initialized = true;
    const rescan = setInterval(arm, RESCAN_MS);
    if (typeof rescan.unref === 'function') rescan.unref();
    arm();
  }

  async function checkNow(sessionId: string): Promise<SignalUpdate | null> {
    // Dedup QUEUED manual checks, not just running ones — the queue is serial,
    // so the `checking` set is always empty by the time the next job starts,
    // and without this every duplicate request would burn a full docker run.
    if (queuedManual.has(sessionId)) {
      throw new Error('A signal check is already running for this strategy.');
    }
    if (queuedManual.size >= MAX_QUEUED_MANUAL) {
      throw new Error('Too many signal checks are queued — try again shortly.');
    }
    queuedManual.add(sessionId);
    try {
      return await enqueue(() => checkSession(sessionId, true));
    } finally {
      queuedManual.delete(sessionId);
      arm(); // the check moved nextCheckAt; re-aim the timer
    }
  }

  return { init, poke: arm, checkNow };
}

// Process-wide singleton, guarded against dev HMR re-initialisation.
const g = globalThis as unknown as { __hindsightSignalScheduler?: SignalScheduler };

export function getSignalScheduler(): SignalScheduler {
  return (g.__hindsightSignalScheduler ??= createSignalScheduler());
}
