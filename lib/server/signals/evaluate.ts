// ============================================================================
// One signal check for one activated session. Re-executes the SAVED strategy
// (never an LLM) through today, then diffs the latest bar's target weights
// against the last bar the user was already messaged about.
//
// Mock mode (HINDSIGHT_AGENT !== 'codex', the selectRunner() rule): regenerate
// deterministically via generateMockCurve with the same inputs the mock runner
// uses for a re-run, just with `period.end = today`. No disk, no docker.
// Codex mode: a scratch `HS_KIND=rerun` container under `${data}/signals/<id>/`
// — NEVER through runManager.startRun. The scratch data/ is emptied on every
// check (always-fresh bars) and the run is hard-killed after 5 minutes.
//
// This module never mutates the session's real workdir, versions, chat,
// status, or dataSnapshotAt — the scratch dir is the only thing it writes.
// ============================================================================

import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import type { EquityPoint, PositionsPoint, Session, SignalChange, SignalUpdate } from '@/lib/types';
import { normalizeResultJson } from '@/lib/server/agent/codexRunner';
import { generateMockCurve } from '@/lib/server/agent/mockCurve';
import {
  ensureDir,
  signalDataDir,
  signalEventsFile,
  signalParamsFile,
  signalResultFile,
  signalStrategyFile,
  signalWorkDir,
  strategyFile,
} from '@/lib/server/paths';

/** Weight moves smaller than this are float noise, not signals (0.5%). */
const MIN_WEIGHT_DELTA = 0.005;
/** Hard wall-clock deadline for a scratch container, then `docker kill`. */
const RUN_DEADLINE_MS = 5 * 60 * 1000;
const DEFAULT_IMAGE = 'hindsight-agent:latest';
const LOG_TAIL_CHARS = 2000;

export interface SignalEvaluation {
  /** The check's outcome (`changes` empty ⇒ HOLD); null ONLY on no-new-bar. */
  update: SignalUpdate | null;
  /** True when the latest bar is the one `activation.lastSignal` already covers. */
  noNewBar: boolean;
  /** Latest bar-close weights for holdings summaries; null without positions. */
  latestWeights: Record<string, number> | null;
  /** Latest portfolio value from the re-run's equity curve, or null. */
  latestValue: number | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Today as `YYYY-MM-DD` in UTC — the params.json `end` for signal re-runs. */
function todayUtcIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Monotonic counter for container-name uniqueness (codexRunner precedent). A
// stable per-session name would wedge every later check with exit 125 if one
// container ever survived (daemon hang mid-kill, a second dev process, …).
let SIGNAL_RUN_COUNTER = 0;

/** Docker-safe, reasonably unique container name for one signal check. */
function signalContainerName(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'session';
  SIGNAL_RUN_COUNTER += 1;
  const n = (Date.now() ^ Math.imul(SIGNAL_RUN_COUNTER, 2654435761)) >>> 0;
  return `hs-signal-${safe}-${n.toString(36).slice(0, 6)}`;
}

/**
 * Execute the session's ACCEPTED strategy code in the scratch workdir with
 * `end = today`, and return the normalized curve + positions. The accepted
 * source of truth is `session.result.code` (what prepareAcceptedWorkState
 * restores); the live workdir's strategy.py is only a legacy fallback — it may
 * hold an unaccepted candidate from a failed refinement.
 */
async function runScratchBacktest(
  session: Session,
): Promise<{ equityCurve: EquityPoint[]; positions?: PositionsPoint[] }> {
  const id = session.id;
  const dir = signalWorkDir(id);
  const startTime = Date.now();
  await ensureDir(dir);

  if (session.result?.code) {
    await writeFile(signalStrategyFile(id), session.result.code, 'utf8');
  } else {
    try {
      await copyFile(strategyFile(id), signalStrategyFile(id));
    } catch {
      throw new Error('No saved strategy code to check — run the backtest once first.');
    }
  }
  const params = {
    start: session.period.start,
    end: todayUtcIso(),
    startingCapital: session.startingCapital,
  };
  await writeFile(signalParamsFile(id), `${JSON.stringify(params, null, 2)}\n`, 'utf8');
  // Always-fresh bars: delete + recreate data/ so the strategy re-fetches
  // through today instead of reusing a stale snapshot.
  await rm(signalDataDir(id), { recursive: true, force: true });
  await ensureDir(signalDataDir(id));
  // A stale result.json from the previous check must not pass for this run's.
  await rm(signalResultFile(id), { force: true });
  closeSync(openSync(signalEventsFile(id), 'a'));

  const image = process.env.HINDSIGHT_DOCKER_IMAGE || DEFAULT_IMAGE;
  const cname = signalContainerName(id);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let logTail = '';
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve();
    };
    const proc = spawn(
      'docker',
      ['run', '--rm', '--name', cname, '-e', 'HS_KIND=rerun', '-v', `${dir}:/work`, image],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const deadline = setTimeout(() => {
      try {
        spawn('docker', ['kill', cname], { stdio: 'ignore' });
      } catch {
        /* docker may be unavailable; nothing more we can do */
      }
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(new Error('The signal check timed out after 5 minutes.'));
    }, RUN_DEADLINE_MS);
    if (typeof deadline.unref === 'function') deadline.unref();
    const appendLog = (chunk: Buffer): void => {
      logTail = (logTail + chunk.toString('utf8')).slice(-LOG_TAIL_CHARS);
    };
    proc.stdout?.on('data', appendLog);
    proc.stderr?.on('data', appendLog);
    proc.on('error', (err) => {
      finish(new Error(`docker failed to start (is the daemon running?): ${err.message}`));
    });
    proc.on('exit', (code) => {
      if (code === 0) return finish();
      // Container output can contain strategy source lines; keep it in the
      // server log only — the error message reaches HTTP response bodies,
      // persisted session state, and outbound provider messages.
      if (logTail) console.error(`[hindsight] signal re-run failed for ${id}:\n${logTail}`);
      finish(
        new Error(`the strategy re-run exited with code ${code} — see the server log for details.`),
      );
    });
  });

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(signalResultFile(id), 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
    throw new Error(
      missing
        ? 'The strategy re-run finished without writing a result.'
        : `The strategy re-run wrote an unreadable result (${(e as Error)?.message ?? String(e)}).`,
    );
  }
  const result = normalizeResultJson(raw, session, startTime, dir);
  return { equityCurve: result.equityCurve, positions: result.positions };
}

/**
 * Index of the diff baseline bar: the last bar already covered by
 * `activation.lastSignal`, so every position change since the previous message
 * is reported — not just the change on the final bar. The check schedule is
 * far sparser than the daily bar series (weekly cadence checks Fridays but the
 * code may rebalance Mondays; missed checks skip days), so diffing the last
 * two bars would silently drop those changes forever. -1 ⇒ nothing to diff.
 */
function baselineIndex(positions: PositionsPoint[], lastSignalDate: string | null): number {
  if (positions.length < 2) return -1;
  if (!lastSignalDate) return positions.length - 2;
  let idx = -1;
  for (let i = 0; i < positions.length; i++) {
    if (positions[i].date > lastSignalDate) break;
    idx = i;
  }
  if (idx < 0) idx = 0; // series starts after the last signal (capped ~750 bars)
  return Math.min(idx, positions.length - 2); // never diff the latest bar against itself
}

/** Per-ticker BUY/SELL changes between two weight books, ticker-sorted. */
function diffChanges(prev: Record<string, number>, next: Record<string, number>): SignalChange[] {
  const tickers = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const changes: SignalChange[] = [];
  for (const ticker of tickers) {
    const from = prev[ticker] ?? 0;
    const to = next[ticker] ?? 0;
    if (Math.abs(to - from) < MIN_WEIGHT_DELTA) continue;
    changes.push({ ticker, action: to > from ? 'BUY' : 'SELL', from, to });
  }
  return changes;
}

/**
 * Run one signal check for `session`. `update.changes` empty means HOLD;
 * `update: null` (with `noNewBar: true`) means the latest available bar was
 * already signalled. Sessions whose saved code reports no positions series
 * yield `inferred: true` updates with empty changes — the messenger tells the
 * user how to upgrade (any refinement re-saves code under the new contract).
 */
export async function evaluateSignals(session: Session): Promise<SignalEvaluation> {
  let equityCurve: EquityPoint[];
  let positions: PositionsPoint[] | undefined;

  if (process.env.HINDSIGHT_AGENT === 'codex') {
    ({ equityCurve, positions } = await runScratchBacktest(session));
  } else {
    // Mirror the mock runner's re-run inputs exactly (prompt, capital), with
    // the period extended through today — deterministic for a given day.
    const curve = generateMockCurve({
      prompt: session.prompt,
      period: { start: session.period.start, end: todayUtcIso() },
      startingCapital: session.startingCapital,
    });
    equityCurve = curve.equityCurve;
    positions = curve.positions;
  }

  const lastBar = positions?.length ? positions[positions.length - 1] : null;
  const latestDate = lastBar?.date ?? equityCurve[equityCurve.length - 1]?.date;
  if (!latestDate) throw new Error('The strategy re-run produced an empty equity curve.');
  const latestWeights = lastBar ? { ...lastBar.weights } : null;
  const latestValue = equityCurve.length ? equityCurve[equityCurve.length - 1].value : null;

  const lastSignalDate = session.activation?.lastSignal?.date ?? null;
  if (lastSignalDate && latestDate <= lastSignalDate) {
    return { update: null, noNewBar: true, latestWeights, latestValue };
  }

  let dayChangePct: number | null = null;
  if (equityCurve.length >= 2) {
    const prev = equityCurve[equityCurve.length - 2].value;
    const last = equityCurve[equityCurve.length - 1].value;
    if (prev > 0) dayChangePct = round1((last / prev - 1) * 100);
  }

  // Net changes since the last-messaged book (baseline-vs-latest weights) —
  // the first check (no lastSignal yet) keeps the plain last-two-bars diff.
  const baseIdx = positions ? baselineIndex(positions, lastSignalDate) : -1;
  const changes =
    positions && baseIdx >= 0 && lastBar
      ? diffChanges(positions[baseIdx].weights, lastBar.weights)
      : [];

  return {
    update: {
      date: latestDate,
      changes,
      dayChangePct,
      inferred: !lastBar,
      checkedAt: Date.now(),
    },
    noNewBar: false,
    latestWeights,
    latestValue,
  };
}
