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

import { writeFile, readFile, rm } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { AgentRunner, RunHandle, RunKind } from '@/lib/agent-runner';
import { STATUS_WORDS } from '@/lib/agent-runner';
import type {
  AgentResponseMetadata,
  Attachment,
  BacktestVersion,
  ChatMessage,
  EquityPoint,
  MetaEvent,
  MessageEvent as ChatMessageEvent,
  PositionsPoint,
  ProgressEvent,
  RunSnapshot,
  Session,
  StatusWord,
  StepEvent,
  StrategyResult,
} from '@/lib/types';
import {
  extractBacktestIds,
  latestBacktest,
  nextBacktestId,
  referencedBacktests,
  snapshotBacktest,
} from '@/lib/backtests';
import { selectRunner } from '@/lib/server/agent';
import { selectBenchmark } from '@/lib/server/benchmark';
import { getSettingsSync } from '@/lib/server/settings';
import * as store from '@/lib/server/store';
import {
  backtestVersionDir,
  backtestVersionResultFile,
  backtestVersionStrategyFile,
  baselineDir,
  baselineResultFile,
  baselineStrategyFile,
  ensureDir,
  paramsFile,
  resultFile,
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
/** Cap on the optional positions series — the most recent bars win (PROTOCOL §4). */
const MAX_POSITIONS_POINTS = 750;

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
  /** Latest agent summary; held until success so trial runs cannot become the displayed answer. */
  pendingAgentMessage: ChatMessageEvent | null;
  /** Model settings captured at run start; null for mock and saved-code runs. */
  responseUsage: Omit<AgentResponseMetadata, 'durationMs'>;
  /** Version whose strategy/result seeded this run. */
  basedOnBacktestId: string | null;
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

/** File-protocol shape of the last result the UI accepted for this session. */
function acceptedResultJson(session: Session): string | null {
  const result = session.result;
  if (!result) return null;
  return `${JSON.stringify(
    {
      name: session.name,
      description: session.description,
      startingCapital: result.startingCapital,
      finalValue: result.finalValue,
      returnPct: result.returnPct,
      equityCurve: result.equityCurve.map((point) => [point.date, point.value]),
      // Optional; JSON.stringify drops the key entirely on legacy results.
      positions: result.positions?.map((point) => [point.date, point.weights]),
      benchmark: result.benchmark?.map((point) => [point.date, point.value]) ?? null,
      benchmarkTicker: result.benchmarkTicker,
      benchmarkReason: result.benchmarkReason,
      benchmarkSource: result.benchmarkSource,
      code: result.code,
      period: session.period,
    },
    null,
    2,
  )}\n`;
}

/** Present one immutable version through the existing accepted-state helpers. */
function sessionAtBacktest(session: Session, version: BacktestVersion): Session {
  return {
    ...session,
    name: version.name,
    description: version.description,
    period: { ...version.period },
    startingCapital: version.startingCapital,
    result: version.result,
  };
}

/** Materialize every explicitly mentioned version where the container can read it. */
async function prepareReferencedWorkStates(
  sessionId: string,
  session: Session,
  versions: BacktestVersion[],
): Promise<void> {
  await Promise.all(
    versions.map(async (version) => {
      await ensureDir(backtestVersionDir(sessionId, version.id));
      const versionSession = sessionAtBacktest(session, version);
      const json = acceptedResultJson(versionSession);
      if (!json) return;
      const writes: Promise<void>[] = [
        writeFile(backtestVersionResultFile(sessionId, version.id), json, 'utf8'),
      ];
      if (version.result.code) {
        writes.push(
          writeFile(
            backtestVersionStrategyFile(sessionId, version.id),
            version.result.code,
            'utf8',
          ),
        );
      }
      await Promise.all(writes);
    }),
  );
}

/**
 * Make the persisted UI result authoritative before reusing agent files.
 * A failed/interrupted refinement may have partially replaced strategy.py or
 * result.json; this prevents that unaccepted candidate leaking into the next
 * request. Refinements also receive immutable baseline copies so an
 * optimization attempt can compare candidates and restore the accepted result.
 */
async function prepareAcceptedWorkState(
  sessionId: string,
  session: Session,
  saveBaseline: boolean,
): Promise<void> {
  const json = acceptedResultJson(session);
  if (!json) return;

  const code = session.result?.code;
  const writes: Promise<void>[] = [writeFile(resultFile(sessionId), json, 'utf8')];
  if (code) writes.push(writeFile(strategyFile(sessionId), code, 'utf8'));

  if (saveBaseline) {
    await ensureDir(baselineDir(sessionId));
    writes.push(writeFile(baselineResultFile(sessionId), json, 'utf8'));
    if (code) writes.push(writeFile(baselineStrategyFile(sessionId), code, 'utf8'));
  }

  await Promise.all(writes);
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

/**
 * Coerce a raw equity-curve value, treating anything that isn't a number or a
 * non-empty numeric string as MISSING (NaN), so the isFinite filter below drops
 * it. Plain `Number()` would turn `null` — a gap in the data — into a real $0
 * point, drawing a crash to zero that never happened.
 */
function toValue(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

/** Normalise any equity-curve shape (EquityPoint[] or `[date,value][]`) to points. */
function toPoints(curve: unknown): EquityPoint[] {
  if (!Array.isArray(curve)) return [];
  const pts: EquityPoint[] = [];
  for (const item of curve) {
    if (Array.isArray(item) && item.length >= 2) {
      pts.push({ date: String(item[0]), value: toValue(item[1]) });
    } else if (item && typeof item === 'object' && 'date' in item && 'value' in item) {
      const o = item as { date: unknown; value: unknown };
      pts.push({ date: String(o.date), value: toValue(o.value) });
    }
  }
  const clean = pts.filter((p) => p.date && Number.isFinite(p.value));
  clean.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return clean;
}

/**
 * Normalise any positions shape (`PositionsPoint[]` or `[date, {TICK: w}][]`)
 * to points. Malformed entries are dropped, weights coerced to finite numbers
 * under trimmed uppercase tickers, dates deduped keeping the last entry, sorted
 * ascending, capped to the most recent bars. Empty in = empty out (omitted).
 */
function toPositions(series: unknown): PositionsPoint[] {
  if (!Array.isArray(series)) return [];
  const byDate = new Map<string, Record<string, number>>();
  for (const item of series) {
    let date = '';
    let rawWeights: unknown;
    if (Array.isArray(item) && item.length >= 2) {
      date = String(item[0]);
      rawWeights = item[1];
    } else if (item && typeof item === 'object' && 'date' in item && 'weights' in item) {
      const o = item as { date: unknown; weights: unknown };
      date = String(o.date);
      rawWeights = o.weights;
    }
    if (!date || !rawWeights || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) {
      continue;
    }
    const weights: Record<string, number> = {};
    for (const [ticker, value] of Object.entries(rawWeights as Record<string, unknown>)) {
      const symbol = ticker.trim().toUpperCase();
      const weight = Number(value);
      if (symbol && Number.isFinite(weight)) weights[symbol] = weight;
    }
    byDate.set(date, weights); // last entry for a date wins
  }
  return [...byDate.entries()]
    .map(([date, weights]) => ({ date, weights }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-MAX_POSITIONS_POINTS);
}

/**
 * Validate + stamp a raw result from the runner into a canonical StrategyResult.
 * Recomputes finalValue/returnPct from the curve and stamps ranAt/durationMs.
 */
function normalizeResult(raw: StrategyResult, session: Session, durationMs: number): StrategyResult {
  const curve = toPoints((raw as { equityCurve?: unknown })?.equityCurve);
  const positions = toPositions((raw as { positions?: unknown })?.positions);
  const rawBench = (raw as { benchmark?: unknown })?.benchmark;
  const benchmark = rawBench == null ? null : toPoints(rawBench);

  const startingCapital =
    firstFinite(raw?.startingCapital, curve[0]?.value, session.startingCapital) ?? 10000;
  const finalValue =
    firstFinite(curve[curve.length - 1]?.value, raw?.finalValue, startingCapital) ?? startingCapital;
  const returnPct = startingCapital !== 0 ? (finalValue / startingCapital - 1) * 100 : 0;

  const candidate: StrategyResult = {
    equityCurve: curve,
    ...(positions.length ? { positions } : {}),
    benchmark: benchmark && benchmark.length ? benchmark : null,
    benchmarkTicker:
      typeof raw?.benchmarkTicker === 'string' ? raw.benchmarkTicker.trim().toUpperCase() : undefined,
    benchmarkReason:
      typeof raw?.benchmarkReason === 'string' ? raw.benchmarkReason.trim() : undefined,
    benchmarkSource: raw?.benchmarkSource,
    finalValue,
    startingCapital,
    returnPct,
    code: typeof raw?.code === 'string' ? raw.code : undefined,
    ranAt: Date.now(),
    durationMs,
  };

  // Every accepted result gets a freshly validated comparison. Agent choices
  // are checked against the actual code universe; missing/invalid choices are
  // re-derived from this result rather than inherited from an older response.
  const selection = selectBenchmark({ ...session, result: candidate });
  return {
    ...candidate,
    benchmarkTicker: selection.ticker,
    benchmarkReason: selection.reason,
    benchmarkSource: selection.source,
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
   * Returns null when the message was suppressed as a duplicate.
   */
  function applyMessage(
    run: ActiveRun,
    e: ChatMessageEvent,
    persistNow = true,
  ): ChatMessage | null {
    const key = messageKey(e.role, e.text);
    if (run.messageKeys.has(key)) return null;
    run.messageKeys.add(key);

    const msg: ChatMessage = {
      id: nanoid(),
      role: e.role,
      text: e.text,
      ...(e.metadata ? { metadata: e.metadata } : {}),
      createdAt: Date.now(),
    };
    run.session.chat.push(msg);
    if (persistNow) persist(run.session);
    return msg;
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
        // strategy.py may run several candidate variants during a refinement.
        // Keep replacing the pending agent summary and publish only the last
        // one after result.json succeeds; otherwise the first (possibly worse)
        // trial can be mistaken for the accepted result. System notes remain
        // genuinely live (data gaps, fetch progress, etc.).
        if (event.role === 'agent') {
          run.pendingAgentMessage = event;
          break;
        }
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
    const backtestId = nextBacktestId(run.session);
    const finalAgentMessage: ChatMessageEvent = {
      ...(run.pendingAgentMessage ?? {
        type: 'message',
        role: 'agent',
        text: 'Backtest completed.',
      }),
      metadata: {
        durationMs: result.durationMs,
        ...run.responseUsage,
        backtestId,
      },
    };
    // Agent-role events are buffered rather than applied during the run, so
    // this append is unique. The generic fallback guarantees every successful
    // version still has a response carrying its copyable id.
    const appendedFinalMessage = applyMessage(run, finalAgentMessage, false);
    run.session.backtests.push(
      snapshotBacktest({
        session: run.session,
        id: backtestId,
        result,
        messageId: appendedFinalMessage?.id,
        basedOn: run.basedOnBacktestId,
      }),
    );

    try {
      await store.saveSession(run.session);
    } catch (err) {
      logError('persist result failed', err);
    }

    if (appendedFinalMessage) {
      broadcast(run.sessionId, { event: 'message', data: finalAgentMessage });
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
    const runner = getRunner();

    const requestedBacktestIds = kind === 'refine' ? extractBacktestIds(message ?? '') : [];
    const referencedVersions =
      kind === 'refine' ? referencedBacktests(session, message ?? '') : [];
    if (requestedBacktestIds.length !== referencedVersions.length) {
      const found = new Set(referencedVersions.map((version) => version.id));
      const missing = requestedBacktestIds.find((id) => !found.has(id));
      throw new Error(`Backtest ${missing ?? requestedBacktestIds[0]} was not found in this strategy.`);
    }
    const referencedBase = referencedVersions[0];
    if (referencedBase && !referencedBase.result.code) {
      throw new Error(
        `Backtest ${referencedBase.id} cannot be restored because its strategy code is unavailable.`,
      );
    }
    const acceptedSession = referencedBase
      ? sessionAtBacktest(session, referencedBase)
      : session;

    const dir = workDir(sessionId);
    await ensureDir(dir);

    // Write params.json for a no-LLM date-only re-run (PROTOCOL §5.6).
    const params = {
      start: acceptedSession.period.start,
      end: acceptedSession.period.end,
      startingCapital: acceptedSession.startingCapital,
    };
    await writeFile(paramsFile(sessionId), `${JSON.stringify(params, null, 2)}\n`, 'utf8');

    // A refresh run discards the cached data snapshot.
    if (kind === 'refresh') {
      await rm(workDataDir(sessionId), { recursive: true, force: true });
    }

    // Restore the last result accepted by the UI before any non-initial run.
    // Refinements also get stable backup files for candidate comparisons and
    // rollback when an "improvement" fails to beat its stated baseline.
    if (kind === 'refine' || kind === 'rerun' || kind === 'refresh') {
      if (referencedVersions.length > 0) {
        await prepareReferencedWorkStates(sessionId, session, referencedVersions);
      }
      await prepareAcceptedWorkState(sessionId, acceptedSession, kind === 'refine');
    }

    const basedOnBacktestId =
      referencedBase?.id ?? (session.result ? (latestBacktest(session)?.id ?? null) : null);

    // A `rerun`/`refresh` re-executes strategy.py with NO agent involved, so it
    // is only possible when a runnable program actually exists. Sessions that
    // never came from a real agent run (seeded demo data), or whose saved code
    // can't fulfil the contract, would otherwise run something that exits 0
    // without writing result.json — surfacing a baffling ENOENT. Escalate those
    // to a full agent run that rebuilds the strategy from the prompt instead.
    // Only the codex runner re-executes the file; the mock always regenerates.
    if ((kind === 'rerun' || kind === 'refresh') && runner.kind === 'codex') {
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

    // Snapshot immediately before runner.start() (there is no await between
    // the two reads), so these are the exact app-wide values Codex receives.
    // Later settings changes must not rewrite an older response's provenance.
    const responseUsage: Omit<AgentResponseMetadata, 'durationMs'> =
      runner.kind === 'mock'
        ? { model: null, effort: null, mode: 'mock' }
        : kind === 'initial' || kind === 'refine'
          ? { ...getSettingsSync(), mode: 'codex' }
          : { model: null, effort: null, mode: 'saved-code' };

    // The agent sees the complete current conversation/history, but its period,
    // capital, strategy, and result begin at the explicitly referenced version.
    const runnerSession = referencedBase
      ? sessionAtBacktest(session, referencedBase)
      : session;

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
      pendingAgentMessage: null,
      responseUsage,
      basedOnBacktestId,
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
      handle = runner.start({
        session: runnerSession,
        workDir: dir,
        kind,
        message,
        attachments,
        ...(responseUsage.mode === 'codex'
          ? { model: responseUsage.model ?? undefined, effort: responseUsage.effort ?? undefined }
          : {}),
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
