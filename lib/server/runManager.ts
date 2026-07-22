// ============================================================================
// Run manager — the process-wide singleton that owns backtest runs.
//
// Responsibilities (PROTOCOL.md §2, §7):
//   * On first init, mark orphaned `running` sessions as `failed`.
//   * startRun(): prepare the workdir (params.json, strategy.py, data/), flip
//     the session to `running`, and drive the selected AgentRunner.
//   * Keep live run state (steps, status word, elapsed) IN MEMORY only, fanning
//     ProgressEvents out to SSE subscribers. Persist RESULTS (and status/chat/
//     meta) to the store.
//   * A ~1s ticker re-broadcasts a runner-authoritative `status` frame so the
//     Working view's elapsed timer stays live.
//   * On success: validate/stamp the result, persist, broadcast result + done.
//   * On failure/interrupt: mark failed, surface the error as an agent chat
//     message, broadcast error + done.
//
// Depends on the agent layer via exactly one import: `selectRunner`.
// ============================================================================

import { writeFile, readFile, rm, access } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { AgentRunner, RunHandle, RunKind } from '@/lib/agent-runner';
import { STATUS_WORDS } from '@/lib/agent-runner';
import type {
  Attachment,
  ChatMessage,
  EquityPoint,
  MetaEvent,
  MessageEvent as ChatMessageEvent,
  ProgressEvent,
  RunSnapshot,
  Session,
  StatusWord,
  StepEvent,
  StrategyResult,
} from '@/lib/types';
import { formatDuration } from '@/lib/format';
import { selectRunner } from '@/lib/server/agent';
import * as store from '@/lib/server/store';
import {
  ensureDir,
  paramsFile,
  strategyFile,
  workDataDir,
  workDir,
} from './paths';

/** How often an active run persists a liveness heartbeat (bumping updatedAt). */
const HEARTBEAT_MS = 10_000;
/** Silence after which a `running` session is considered abandoned. */
const STALE_MS = 45_000;
/** How often to sweep for abandoned runs. */
const SWEEP_MS = 30_000;

/** A single SSE frame: an `event:` name + a JSON-serialisable `data` payload. */
export interface SseFrame {
  /** `snapshot` or a ProgressEvent `type`. */
  event: string;
  data: unknown;
}

export interface RunManager {
  startRun(
    sessionId: string,
    kind: RunKind,
    message?: string,
    attachments?: Attachment[],
  ): Promise<void>;
  subscribe(sessionId: string, send: (frame: SseFrame) => void): () => void;
  interrupt(sessionId: string): Promise<void>;
  isActive(sessionId: string): boolean;
}

/** Live, in-memory state for one active run. Never persisted. */
interface ActiveRun {
  sessionId: string;
  kind: RunKind;
  /** The session object mutated + persisted over the run's lifetime. */
  session: Session;
  controller: AbortController;
  handle: RunHandle | null;
  /** Latest state per step id (upserted). */
  steps: StepEvent[];
  statusWord: StatusWord;
  /** Skeleton keys of chat messages already posted by THIS run (dedupe). */
  messageKeys: Set<string>;
  /** Last time this run's liveness heartbeat was persisted. */
  lastHeartbeatAt: number;
  runStartedAt: number;
  /** When the agent last sent a status word (for subtle auto-cycling). */
  lastStatusAt: number;
  ticker: ReturnType<typeof setInterval> | null;
  /** Set when this run is being replaced by a newer one — its callbacks no-op. */
  superseded: boolean;
}

/** Per-session runtime: SSE subscribers + the (optional) active run. */
interface SessionRuntime {
  subscribers: Set<(frame: SseFrame) => void>;
  active: ActiveRun | null;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Can this session's saved strategy.py satisfy a no-LLM re-run?
 *
 * A conforming program always writes /work/result.json (AGENTS.md mandates it),
 * so requiring that reference is a cheap, deterministic pre-flight check. It
 * rejects illustrative/pseudo-code that would parse, do nothing, and exit 0 —
 * the failure mode that surfaces as "produced no valid result.json".
 */
async function strategyCanProduceResult(sessionId: string): Promise<boolean> {
  try {
    const src = await readFile(strategyFile(sessionId), 'utf8');
    return src.includes('result.json');
  } catch {
    return false; // no strategy.py at all
  }
}

function logError(context: string, err: unknown): void {
   
  console.error(`[hindsight] ${context}`, err);
}

/** Turn a rejection into human-readable chat text (PROTOCOL §4). */
function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; aborted?: boolean; message?: string };
    if (e.name === 'AbortError' || e.aborted) return 'Run interrupted.';
    if (typeof e.message === 'string' && e.message.trim()) return e.message.trim();
  }
  const s = String(err);
  return s && s !== '[object Object]' ? s : 'The backtest failed.';
}

function firstFinite(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Normalise any equity-curve shape (EquityPoint[] or `[date,value][]`) to points. */
function toPoints(curve: unknown): EquityPoint[] {
  if (!Array.isArray(curve)) return [];
  const pts: EquityPoint[] = [];
  for (const item of curve) {
    if (Array.isArray(item) && item.length >= 2) {
      pts.push({ date: String(item[0]), value: Number(item[1]) });
    } else if (item && typeof item === 'object' && 'date' in item && 'value' in item) {
      const o = item as { date: unknown; value: unknown };
      pts.push({ date: String(o.date), value: Number(o.value) });
    }
  }
  const clean = pts.filter((p) => p.date && Number.isFinite(p.value));
  clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return clean;
}

/**
 * Validate + stamp a raw result from the runner into a canonical StrategyResult.
 * Recomputes finalValue/returnPct from the curve and stamps ranAt/durationMs.
 */
function normalizeResult(raw: StrategyResult, session: Session, durationMs: number): StrategyResult {
  const curve = toPoints((raw as { equityCurve?: unknown })?.equityCurve);
  const rawBench = (raw as { benchmark?: unknown })?.benchmark;
  const benchmark = rawBench == null ? null : toPoints(rawBench);

  const startingCapital =
    firstFinite(raw?.startingCapital, curve[0]?.value, session.startingCapital) ?? 10000;
  const finalValue =
    firstFinite(curve[curve.length - 1]?.value, raw?.finalValue, startingCapital) ?? startingCapital;
  const returnPct = startingCapital !== 0 ? (finalValue / startingCapital - 1) * 100 : 0;

  return {
    equityCurve: curve,
    benchmark: benchmark && benchmark.length ? benchmark : null,
    finalValue,
    startingCapital,
    returnPct,
    code: typeof raw?.code === 'string' ? raw.code : undefined,
    ranAt: Date.now(),
    durationMs,
  };
}

function createRunManager(): RunManager {
  const runtimes = new Map<string, SessionRuntime>();
  let cachedRunner: AgentRunner | null = null;

  const getRunner = (): AgentRunner => (cachedRunner ??= selectRunner());

  // Reap runs abandoned by a dead process (PROTOCOL §1, "persist results only").
  // This is a liveness sweep, not a boot wipe: active runs heartbeat every
  // HEARTBEAT_MS, so only sessions silent for STALE_MS are failed, and runs this
  // process owns are always protected. Running it periodically (rather than once
  // at init) means a run orphaned by a crash is still cleaned up after the grace
  // period, while a live run survives another instance initialising — which is
  // exactly what `next dev` does on every recompile.
  const sweep = (): void => {
    void store
      .markOrphanedRunningFailed(STALE_MS, (id) => runtimeFor(id).active !== null)
      .then((reaped) => {
        for (const id of reaped) {
          broadcast(id, { event: 'error', data: { type: 'error', message: 'Run interrupted.' } });
          broadcast(id, { event: 'done', data: { type: 'done' } });
        }
      })
      .catch((err) => logError('orphan sweep failed', err));
  };
  sweep();
  const sweepTimer = setInterval(sweep, SWEEP_MS);
  // Never hold the process open just for the sweep.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

  function runtimeFor(sessionId: string): SessionRuntime {
    let rt = runtimes.get(sessionId);
    if (!rt) {
      rt = { subscribers: new Set(), active: null };
      runtimes.set(sessionId, rt);
    }
    return rt;
  }

  function broadcast(sessionId: string, frame: SseFrame): void {
    const rt = runtimes.get(sessionId);
    if (!rt) return;
    for (const send of rt.subscribers) {
      try {
        send(frame);
      } catch (err) {
        logError('subscriber send failed', err);
      }
    }
  }

  function broadcastStatus(run: ActiveRun): void {
    broadcast(run.sessionId, {
      event: 'status',
      data: { type: 'status', label: run.statusWord, elapsedMs: Date.now() - run.runStartedAt },
    });
  }

  function stopTicker(run: ActiveRun): void {
    if (run.ticker) {
      clearInterval(run.ticker);
      run.ticker = null;
    }
  }

  function persist(session: Session): void {
    store.saveSession(session).catch((err) => logError('saveSession failed', err));
  }

  function upsertStep(run: ActiveRun, step: StepEvent): void {
    const idx = run.steps.findIndex((s) => s.id === step.id);
    if (idx >= 0) run.steps[idx] = step;
    else run.steps.push(step);
  }

  /** Ticker callback: cycle the status word if the agent's gone quiet, re-broadcast. */
  function tick(run: ActiveRun): void {
    if (runtimeFor(run.sessionId).active !== run) return;
    const now = Date.now();
    if (now - run.lastStatusAt > 8000) {
      const idx = STATUS_WORDS.indexOf(run.statusWord);
      if (idx >= 0 && idx < STATUS_WORDS.length - 1) {
        run.statusWord = STATUS_WORDS[idx + 1];
      }
      run.lastStatusAt = now;
    }
    // Liveness heartbeat: bump updatedAt so the orphan sweep (here or in another
    // server instance — `next dev` re-evaluates modules) can tell a live run from
    // one abandoned by a dead process. Cheap: one small JSON write per interval.
    if (now - run.lastHeartbeatAt > HEARTBEAT_MS) {
      run.lastHeartbeatAt = now;
      persist(run.session);
    }
    broadcastStatus(run);
  }

  function applyMeta(run: ActiveRun, e: MetaEvent): void {
    run.session.name = e.name;
    run.session.description = e.description;
    persist(run.session);
  }

  /**
   * Key a message by its "skeleton": role + text with all digits and non-word
   * characters stripped. Two summaries of the same run that differ only in
   * rounding ($18,653.90 vs $18,653.91) collapse to the same key.
   */
  function messageKey(role: string, text: string): string {
    return `${role}:${text.toLowerCase().replace(/[\d\W_]+/g, '')}`;
  }

  /**
   * Append an agent/system chat message, suppressing repeats WITHIN a run.
   * Agents legitimately execute their own strategy.py more than once during a
   * run (write → verify), and that script re-emits its summary each time —
   * which would otherwise post two near-identical bubbles differing only by a
   * cent of rounding. Scoping to the run is what makes this safe: a later run
   * (a rerun over new dates) starts with an empty key set, so its genuinely new
   * summary still appends.
   * Returns false when the message was suppressed as a duplicate.
   */
  function applyMessage(run: ActiveRun, e: ChatMessageEvent): boolean {
    const key = messageKey(e.role, e.text);
    if (run.messageKeys.has(key)) return false;
    run.messageKeys.add(key);

    const msg: ChatMessage = {
      id: nanoid(),
      role: e.role,
      text: e.text,
      createdAt: Date.now(),
    };
    run.session.chat.push(msg);
    persist(run.session);
    return true;
  }

  /** Handle one ProgressEvent from the runner — bound to the specific run. */
  function handleEvent(run: ActiveRun, event: ProgressEvent): void {
    // Ignore stray events from a superseded/finished run.
    if (run.superseded || runtimeFor(run.sessionId).active !== run) return;

    switch (event.type) {
      case 'step':
        upsertStep(run, event);
        broadcast(run.sessionId, { event: 'step', data: event });
        break;
      case 'status':
        run.statusWord = event.label;
        run.lastStatusAt = Date.now();
        broadcastStatus(run);
        break;
      case 'meta':
        applyMeta(run, event);
        broadcast(run.sessionId, { event: 'meta', data: event });
        break;
      case 'message':
        // Suppressed duplicates are not broadcast either, so the live view and
        // the persisted chat stay in agreement.
        if (applyMessage(run, event)) {
          broadcast(run.sessionId, { event: 'message', data: event });
        }
        break;
      case 'log':
        broadcast(run.sessionId, { event: 'log', data: event });
        break;
      default:
        // result/error/done are produced by the run manager, not the agent.
        broadcast(run.sessionId, { event: (event as { type: string }).type, data: event });
    }
  }

  async function onRunSuccess(run: ActiveRun, rawResult: StrategyResult): Promise<void> {
    const rt = runtimeFor(run.sessionId);
    if (run.superseded || rt.active !== run) return;
    stopTicker(run);
    // Claim ownership synchronously — before any await — so an interrupt() or a
    // newly-started run landing during the save window can't race this handler
    // (interrupt's `if (!rt.active) return` no-ops; a fresh run keeps its own
    // rt.active). Prevents duplicate terminal frames and orphaned runs.
    run.superseded = true;
    rt.active = null;

    const durationMs = Date.now() - run.runStartedAt;
    const result = normalizeResult(rawResult, run.session, durationMs);

    // Adopt a period/startingCapital the agent may have inferred from the prompt.
    const rawPeriod = (rawResult as { period?: { start?: unknown; end?: unknown } })?.period;
    if (rawPeriod && typeof rawPeriod.start === 'string' && typeof rawPeriod.end === 'string') {
      run.session.period = { start: rawPeriod.start, end: rawPeriod.end };
    }
    run.session.startingCapital = result.startingCapital;
    run.session.result = result;
    run.session.status = 'done';
    run.session.dataSnapshotAt = Date.now();
    run.session.chat.push({
      id: nanoid(),
      role: 'system',
      text: `Backtest finished in ${formatDuration(result.durationMs)}`,
      createdAt: Date.now(),
    });

    try {
      await store.saveSession(run.session);
    } catch (err) {
      logError('persist result failed', err);
    }

    broadcast(run.sessionId, { event: 'result', data: { type: 'result', result } });
    broadcast(run.sessionId, { event: 'done', data: { type: 'done' } });
  }

  async function onRunFailure(run: ActiveRun, err: unknown): Promise<void> {
    const rt = runtimeFor(run.sessionId);
    if (run.superseded || rt.active !== run) return;
    stopTicker(run);
    // Claim ownership synchronously — before any await — so an interrupt() or a
    // newly-started run landing during the save window can't race this handler.
    run.superseded = true;
    rt.active = null;

    const text = errorText(err);
    run.session.status = 'failed';
    run.session.chat.push({ id: nanoid(), role: 'agent', text, createdAt: Date.now() });

    try {
      await store.saveSession(run.session);
    } catch (saveErr) {
      logError('persist failure failed', saveErr);
    }

    broadcast(run.sessionId, { event: 'error', data: { type: 'error', message: text } });
    broadcast(run.sessionId, { event: 'done', data: { type: 'done' } });
  }

  /** Silently tear down the current active run (used before starting a new one). */
  async function stopActive(sessionId: string): Promise<void> {
    const rt = runtimeFor(sessionId);
    const run = rt.active;
    if (!run) return;
    run.superseded = true;
    stopTicker(run);
    rt.active = null;
    try {
      run.controller.abort();
    } catch {
      /* ignore */
    }
    try {
      await run.handle?.interrupt();
    } catch {
      /* ignore */
    }
  }

  async function startRun(
    sessionId: string,
    kind: RunKind,
    message?: string,
    attachments?: Attachment[],
  ): Promise<void> {
    // Interrupt any run already in flight for this session (silently).
    if (runtimeFor(sessionId).active) {
      await stopActive(sessionId);
    }

    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const dir = workDir(sessionId);
    await ensureDir(dir);

    // Write params.json for a no-LLM date-only re-run (PROTOCOL §5.6).
    const params = {
      start: session.period.start,
      end: session.period.end,
      startingCapital: session.startingCapital,
    };
    await writeFile(paramsFile(sessionId), `${JSON.stringify(params, null, 2)}\n`, 'utf8');

    // A refresh run discards the cached data snapshot.
    if (kind === 'refresh') {
      await rm(workDataDir(sessionId), { recursive: true, force: true });
    }

    // For re-runs, restore strategy.py from the saved result if it's missing.
    if ((kind === 'refine' || kind === 'rerun' || kind === 'refresh') && session.result?.code) {
      if (!(await fileExists(strategyFile(sessionId)))) {
        await writeFile(strategyFile(sessionId), session.result.code, 'utf8');
      }
    }

    // A `rerun`/`refresh` re-executes strategy.py with NO agent involved, so it
    // is only possible when a runnable program actually exists. Sessions that
    // never came from a real agent run (seeded demo data), or whose saved code
    // can't fulfil the contract, would otherwise run something that exits 0
    // without writing result.json — surfacing a baffling ENOENT. Escalate those
    // to a full agent run that rebuilds the strategy from the prompt instead.
    // Only the codex runner re-executes the file; the mock always regenerates.
    if ((kind === 'rerun' || kind === 'refresh') && getRunner().kind === 'codex') {
      if (!(await strategyCanProduceResult(sessionId))) {
        kind = 'initial';
        session.chat.push({
          id: nanoid(),
          role: 'system',
          text: 'No runnable strategy saved for this session — rebuilding it from the prompt.',
          createdAt: Date.now(),
        });
      }
    }

    session.status = 'running';
    // An image-only refinement has empty text but is still a real user turn, so
    // post the bubble whenever either half is present.
    if (kind === 'refine' && (message || attachments?.length)) {
      session.chat.push({
        id: nanoid(),
        role: 'user',
        text: message ?? '',
        ...(attachments?.length ? { attachments } : {}),
        createdAt: Date.now(),
      });
    }
    await store.saveSession(session);

    const controller = new AbortController();
    const now = Date.now();
    const run: ActiveRun = {
      sessionId,
      kind,
      session,
      controller,
      handle: null,
      steps: [],
      statusWord: STATUS_WORDS[0],
      messageKeys: new Set<string>(),
      lastHeartbeatAt: now,
      runStartedAt: now,
      lastStatusAt: now,
      ticker: null,
      superseded: false,
    };
    runtimeFor(sessionId).active = run;

    const onEvent = (event: ProgressEvent): void => handleEvent(run, event);

    let handle: RunHandle;
    try {
      handle = getRunner().start({
        session,
        workDir: dir,
        kind,
        message,
        attachments,
        onEvent,
        signal: controller.signal,
      });
    } catch (err) {
      await onRunFailure(run, err);
      return;
    }

    run.handle = handle;
    run.ticker = setInterval(() => tick(run), 1000);
    handle.done.then(
      (result) => {
        onRunSuccess(run, result).catch((err) => logError('onRunSuccess failed', err));
      },
      (err) => {
        onRunFailure(run, err).catch((e) => logError('onRunFailure failed', e));
      },
    );

    // Nudge any already-connected client into the working view immediately.
    broadcastStatus(run);
  }

  function buildSnapshot(sessionId: string, run: ActiveRun | null, status: Session['status']): RunSnapshot {
    if (run) {
      return {
        sessionId,
        status: 'running',
        steps: run.steps.slice(),
        status_line: { label: run.statusWord, elapsedMs: Date.now() - run.runStartedAt },
        active: true,
      };
    }
    return { sessionId, status, steps: [], status_line: null, active: false };
  }

  async function sendSnapshot(sessionId: string, send: (frame: SseFrame) => void): Promise<void> {
    const run = runtimeFor(sessionId).active;
    let snapshot: RunSnapshot;
    if (run) {
      snapshot = buildSnapshot(sessionId, run, 'running');
    } else {
      const session = await store.getSession(sessionId);
      snapshot = buildSnapshot(sessionId, null, session?.status ?? 'failed');
    }
    try {
      send({ event: 'snapshot', data: snapshot });
    } catch (err) {
      logError('snapshot send failed', err);
    }
  }

  function subscribe(sessionId: string, send: (frame: SseFrame) => void): () => void {
    const rt = runtimeFor(sessionId);
    let cancelled = false;
    // The mandatory first frame is the `snapshot` (PROTOCOL §7); dispatch it
    // BEFORE adding the subscriber so no concurrent broadcast can jump ahead.
    const run = rt.active;
    if (run) {
      // Active run: the snapshot is built synchronously. Send, then subscribe.
      const snapshot = buildSnapshot(sessionId, run, 'running');
      try {
        send({ event: 'snapshot', data: snapshot });
      } catch (err) {
        logError('snapshot send failed', err);
      }
      rt.subscribers.add(send);
    } else {
      // Idle: the snapshot needs a disk read. Await it, then subscribe (unless
      // the stream was already torn down while we were reading).
      void sendSnapshot(sessionId, send).then(() => {
        if (!cancelled) rt.subscribers.add(send);
      });
    }
    return () => {
      cancelled = true;
      rt.subscribers.delete(send);
    };
  }

  async function interrupt(sessionId: string): Promise<void> {
    const rt = runtimeFor(sessionId);
    const run = rt.active;
    if (!run) return;

    // Take ownership so the eventual `done` rejection's handler no-ops, and mark
    // failed inline (awaited) — so a caller can safely delete right after us
    // without the async reject path re-persisting the session.
    run.superseded = true;
    stopTicker(run);
    rt.active = null;
    try {
      run.controller.abort();
    } catch {
      /* ignore */
    }
    try {
      await run.handle?.interrupt();
    } catch {
      /* ignore */
    }

    const text = 'Run interrupted.';
    run.session.status = 'failed';
    run.session.chat.push({ id: nanoid(), role: 'agent', text, createdAt: Date.now() });
    try {
      await store.saveSession(run.session);
    } catch (err) {
      logError('persist interrupt failed', err);
    }
    broadcast(sessionId, { event: 'error', data: { type: 'error', message: text } });
    broadcast(sessionId, { event: 'done', data: { type: 'done' } });
  }

  function isActive(sessionId: string): boolean {
    return runtimeFor(sessionId).active !== null;
  }

  return { startRun, subscribe, interrupt, isActive };
}

// Process-wide singleton, guarded against dev HMR re-initialisation.
const g = globalThis as unknown as { __hindsightRunManager?: RunManager };
export const runManager: RunManager = (g.__hindsightRunManager ??= createRunManager());
