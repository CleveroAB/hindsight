// ============================================================================
// CodexRunner — the REAL AgentRunner. It runs the backtest inside a Docker
// container that either invokes `codex exec` (initial/refine) or just re-executes
// the saved strategy.py (rerun/refresh). It streams progress by tailing the
// container-written /work/events.ndjson, and on exit reads /work/result.json.
//
// NOTE: this path is not exercised in the current environment (the Docker daemon
// is down). It is written to be correct and to DEGRADE GRACEFULLY: if docker can't
// launch, or the run produces no valid result.json, `done` rejects with a clear
// error (including the tail of agent.log), which the run manager surfaces as a
// chat message.
//
// Wiring (see PROTOCOL §2/§3/§4 and .env.example):
//   docker run --rm --name <cname>
//     -e HS_KIND=<kind> [-e HS_MODEL=<model> -e HS_EFFORT=<effort> -e HS_PROMPT=<prompt>]
//     -v <workDir>:/work -v <codexHome>:/codex-host:ro <image>
//   The image's entrypoint dispatches on HS_KIND:
//     rerun/refresh -> `python /work/strategy.py`
//     initial/refine -> `codex exec --dangerously-bypass-approvals-and-sandbox -C /work
//                        -m "$HS_MODEL" -c model_reasoning_effort="$HS_EFFORT" "$HS_PROMPT"`
//   Model + effort are snapshotted from the settings store by the run manager
//   (with a direct-call fallback here) so persisted provenance matches Codex.
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, closeSync, openSync, readFileSync, statSync, type WriteStream } from 'node:fs';
import { open as openFile, stat as statFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentRunner, RunHandle, RunInput } from '@/lib/agent-runner';
import { STATUS_WORDS } from '@/lib/agent-runner';
import type { EquityPoint, Period, PositionsPoint, StatusWord, StrategyResult } from '@/lib/types';
import { hashSeed } from '@/lib/chart';
import { getSettingsSync } from '@/lib/server/settings';
import { buildCodexPrompt } from './prompt';

const DEFAULT_IMAGE = 'hindsight-agent:latest';
const DEFAULT_CODEX_HOME = '~/.codex';
const TAIL_INTERVAL_MS = 300;
const LOG_TAIL_CHARS = 4000;
/** Cap on the optional positions series — the most recent bars win (PROTOCOL §4). */
const MAX_POSITIONS_POINTS = 750;

// Monotonic counter for container-name uniqueness. Combined with a hash of the
// session id, this stays unique across process restarts WITHOUT depending on
// Math.random (which the wider codebase avoids for reproducibility).
let RUN_COUNTER = 0;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** Docker-safe, reasonably unique container name for this run. */
function containerName(sessionId: string): string {
  RUN_COUNTER += 1;
  const n = (hashSeed(sessionId) ^ Math.imul(RUN_COUNTER, 2654435761)) >>> 0;
  const safe = sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 24) || 'session';
  return `hs-${safe}-${n.toString(36).slice(0, 6)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Convert a raw result.json shape into a canonical StrategyResult.
 * Exported for the signals engine, which re-executes saved code in a scratch
 * workdir and must read its result.json exactly the way a real run would.
 */
export function normalizeResultJson(
  raw: unknown,
  session: RunInput['session'],
  startTime: number,
  workDir: string,
): StrategyResult & { period?: Period } {
  const j = (raw ?? {}) as {
    equityCurve?: unknown;
    positions?: unknown;
    benchmark?: unknown;
    benchmarkTicker?: unknown;
    benchmarkReason?: unknown;
    finalValue?: unknown;
    returnPct?: unknown;
    startingCapital?: unknown;
    code?: unknown;
    period?: { start?: unknown; end?: unknown };
  };

  const toPoints = (curve: unknown): EquityPoint[] => {
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
    return pts
      .filter((p) => p.date && Number.isFinite(p.value))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  };

  // Mirror of toPoints for the OPTIONAL positions series ([date, {TICK: w}]
  // tuples or {date, weights} objects). Malformed entries are dropped, weights
  // coerced to finite numbers under trimmed uppercase tickers, dates deduped
  // keeping the last entry, sorted ascending, capped to the most recent bars.
  const toPositions = (series: unknown): PositionsPoint[] => {
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
  };

  const equityCurve = toPoints(j.equityCurve);
  if (equityCurve.length === 0) {
    throw new Error('result.json has no usable equityCurve');
  }

  // Optional bar-close target weights; absent/invalid means the field is omitted.
  const positions = toPositions(j.positions);

  const startingCapital =
    typeof j.startingCapital === 'number' && Number.isFinite(j.startingCapital)
      ? j.startingCapital
      : session.startingCapital;

  const finalFromCurve = equityCurve[equityCurve.length - 1].value;
  let finalValue =
    typeof j.finalValue === 'number' && Number.isFinite(j.finalValue) ? j.finalValue : finalFromCurve;
  // Trust the curve if the stated final is inconsistent with it.
  if (Math.abs(finalValue - finalFromCurve) > 0.5) finalValue = finalFromCurve;

  const computedPct = startingCapital !== 0 ? (finalValue / startingCapital - 1) * 100 : 0;
  let returnPct =
    typeof j.returnPct === 'number' && Number.isFinite(j.returnPct) ? j.returnPct : computedPct;
  if (Math.abs(returnPct - computedPct) > 0.2) returnPct = computedPct;

  let benchmark: EquityPoint[] | null = null;
  if (j.benchmark != null) {
    const b = toPoints(j.benchmark);
    benchmark = b.length ? b : null;
  }

  let code: string | undefined = typeof j.code === 'string' ? j.code : undefined;
  if (!code) {
    try {
      code = readFileSync(path.join(workDir, 'strategy.py'), 'utf8');
    } catch {
      /* strategy.py may not exist; leave code undefined */
    }
  }

  const result: StrategyResult & { period?: Period } = {
    equityCurve,
    ...(positions.length ? { positions } : {}),
    benchmark,
    ...(typeof j.benchmarkTicker === 'string'
      ? {
          benchmarkTicker: j.benchmarkTicker.trim().toUpperCase(),
          benchmarkSource: 'agent' as const,
        }
      : {}),
    ...(typeof j.benchmarkReason === 'string'
      ? { benchmarkReason: j.benchmarkReason.trim() }
      : {}),
    finalValue: round2(finalValue),
    startingCapital,
    returnPct: round1(returnPct),
    code,
    ranAt: Date.now(),
    durationMs: Date.now() - startTime,
  };

  // Pass an agent-inferred period through; the run manager adopts it if present.
  if (j.period && typeof j.period.start === 'string' && typeof j.period.end === 'string') {
    result.period = { start: j.period.start, end: j.period.end };
  }

  return result;
}

export class CodexRunner implements AgentRunner {
  readonly kind = 'codex' as const;

  start(input: RunInput): RunHandle {
    const { session, workDir, kind, message, attachments, onEvent, signal } = input;
    const startTime = Date.now();

    const image = process.env.HINDSIGHT_DOCKER_IMAGE || DEFAULT_IMAGE;
    const codexHome = expandHome(process.env.HINDSIGHT_CODEX_HOME || DEFAULT_CODEX_HOME);
    const eventsPath = path.join(workDir, 'events.ndjson');
    const resultPath = path.join(workDir, 'result.json');
    const logPath = path.join(workDir, 'agent.log');
    const cname = containerName(session.id);

    // Ensure the events file exists before we start tailing it.
    try {
      closeSync(openSync(eventsPath, 'a'));
    } catch {
      /* directory should exist (run manager created it); ignore */
    }

    let settled = false;
    // eslint-disable-next-line prefer-const -- assigned once, but only after the closures above it that reference it
    let child: ChildProcess | undefined;
    let poll: ReturnType<typeof setInterval> | null = null;
    let logStream: WriteStream | null = null;
    let logTail = '';

    let resolveDone!: (r: StrategyResult) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<StrategyResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    // ---- events.ndjson tail (byte-offset based; only reads new bytes) --------
    // events.ndjson PERSISTS across runs in a session workDir (the entrypoint
    // touches, never truncates), so start the tail at its CURRENT size — only
    // bytes appended during THIS run are forwarded, not a prior run's lines.
    let offset = 0;
    try {
      offset = statSync(eventsPath).size;
    } catch {
      offset = 0;
    }
    let carry = '';
    let inFlight = false;

    const forwardLine = (line: string): void => {
      let obj: { type?: unknown; [k: string]: unknown };
      try {
        obj = JSON.parse(line);
      } catch {
        return; // parse failures are logged inside the container; ignore here
      }
      if (!obj || typeof obj.type !== 'string') return;
      switch (obj.type) {
        case 'status': {
          // Only forward one of the five known StatusWords; a bogus label would
          // halt the whimsical status auto-cycle (indexOf -> -1) and render raw.
          if (!STATUS_WORDS.includes(obj.label as StatusWord)) break;
          // The runner is authoritative on elapsed time; stamp it ourselves.
          onEvent({
            type: 'status',
            label: obj.label as StatusWord,
            elapsedMs: Date.now() - startTime,
          });
          break;
        }
        case 'step': {
          const id = obj.id;
          const state = obj.state;
          if (typeof id === 'string' && (state === 'active' || state === 'done')) {
            onEvent({ type: 'step', id, label: String(obj.label ?? ''), state });
          }
          break;
        }
        case 'meta': {
          onEvent({
            type: 'meta',
            name: String(obj.name ?? ''),
            description: String(obj.description ?? ''),
          });
          break;
        }
        case 'message': {
          const role = obj.role;
          if (role === 'agent' || role === 'system') {
            onEvent({ type: 'message', role, text: String(obj.text ?? '') });
          }
          break;
        }
        case 'log': {
          onEvent({ type: 'log', text: String(obj.text ?? '') });
          break;
        }
        default:
          // result/error/done are not valid agent events — ignore.
          break;
      }
    };

    const pump = async (): Promise<void> => {
      // Re-entrancy guard: the 300ms poll and the exit-handler's final flush can
      // both invoke pump(); without this, two overlapping reads forward the same
      // byte range twice (duplicated trailing events).
      if (inFlight) return;
      inFlight = true;
      try {
        const st = await statFile(eventsPath);
        if (st.size <= offset) return;
        const fh = await openFile(eventsPath, 'r');
        try {
          const len = st.size - offset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          offset = st.size;
          carry += buf.toString('utf8');
          let nl: number;
          while ((nl = carry.indexOf('\n')) >= 0) {
            const line = carry.slice(0, nl).trim();
            carry = carry.slice(nl + 1);
            if (line) forwardLine(line);
          }
        } finally {
          await fh.close();
        }
      } catch {
        // File may not exist yet or be mid-write; retried on the next tick.
      } finally {
        inFlight = false;
      }
    };

    // ---- container stdout/stderr -> agent.log (debug only) ------------------
    try {
      logStream = createWriteStream(logPath, { flags: 'a' });
    } catch {
      logStream = null;
    }
    const appendLog = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try {
        logStream?.write(s);
      } catch {
        /* ignore log write errors */
      }
      logTail = (logTail + s).slice(-LOG_TAIL_CHARS);
    };

    // ---- settlement helpers -------------------------------------------------
    const onAbort = (): void => {
      void interrupt();
    };

    /** Returns true if the run was ALREADY settled (caller should not settle again). */
    const settle = (): boolean => {
      if (settled) return true;
      settled = true;
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
      try {
        logStream?.end();
      } catch {
        /* ignore */
      }
      return false;
    };

    const interrupt = async (): Promise<void> => {
      // Best-effort hard kill of the container, then the child process itself.
      try {
        spawn('docker', ['kill', cname], { stdio: 'ignore' });
      } catch {
        /* docker may be unavailable; nothing more we can do */
      }
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      const already = settle();
      if (!already) rejectDone(new Error('interrupted'));
    };

    // ---- build docker args --------------------------------------------------
    const args: string[] = ['run', '--rm', '--name', cname, '-e', `HS_KIND=${kind}`];
    if (kind === 'initial' || kind === 'refine') {
      // The run manager supplies one atomic settings snapshot so the values
      // passed to Codex are exactly the ones persisted on the response. Keep a
      // fallback for direct runner callers outside the manager.
      const current = input.model && input.effort
        ? { model: input.model, effort: input.effort }
        : getSettingsSync();
      const { model, effort } = current;
      const codexPrompt = buildCodexPrompt({ session, kind, message, attachments });
      // spawn() takes an argv array (no shell), so the prompt is a single, safely
      // quoted argument regardless of its content.
      args.push('-e', `HS_MODEL=${model}`, '-e', `HS_EFFORT=${effort}`, '-e', `HS_PROMPT=${codexPrompt}`);
      // Attached images become `codex exec -i <path>` args inside the container.
      // Newline-separated because upload names are [A-Za-z0-9_-].ext — no
      // newlines possible — and the entrypoint splits on exactly that.
      if (attachments?.length) {
        const paths = attachments.map((a) => `/work/uploads/${a.name}`).join('\n');
        args.push('-e', `HS_IMAGES=${paths}`);
      }
    }
    // The host Codex home is mounted READ-ONLY at /codex-host (never /root/.codex):
    // it holds the user's live state and can be gigabytes. The entrypoint copies
    // just auth.json into a writable container-local CODEX_HOME — Codex refuses to
    // start if its home is read-only.
    args.push('-v', `${workDir}:/work`, '-v', `${codexHome}:/codex-host:ro`, image);

    // ---- launch -------------------------------------------------------------
    let proc: ChildProcess;
    try {
      proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      settle();
      rejectDone(new Error(`failed to launch docker: ${(err as Error)?.message ?? String(err)}`));
      return { interrupt: async () => {}, done };
    }
    child = proc;

    // Start tailing only once the child is alive.
    poll = setInterval(() => {
      void pump();
    }, TAIL_INTERVAL_MS);

    proc.stdout?.on('data', appendLog);
    proc.stderr?.on('data', appendLog);

    proc.on('error', (err) => {
      const already = settle();
      if (!already) {
        rejectDone(
          new Error(
            `docker failed to start (is the daemon running?): ${err.message}` +
              (logTail ? `\n${logTail.slice(-1500)}` : ''),
          ),
        );
      }
    });

    proc.on('exit', (code) => {
      // Final flush of any trailing events, then resolve/reject.
      void (async () => {
        // Stop the poll BEFORE the final flush so no new pump starts mid-flush.
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        await pump();
        if (settled) return;
        if (code === 0) {
          try {
            const raw = JSON.parse(await readFile(resultPath, 'utf8'));
            const result = normalizeResultJson(raw, session, startTime, workDir);
            const already = settle();
            if (!already) resolveDone(result);
          } catch (e) {
            const already = settle();
            if (!already) {
              // Distinguish "never wrote a result" (the usual case: the program
              // ran but isn't a conforming backtest) from a malformed one, and
              // keep the text human-readable — it is shown as a chat message.
              const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
              const detail = missing
                ? 'the run finished without writing a result'
                : `the result file was unreadable (${(e as Error)?.message ?? String(e)})`;
              rejectDone(
                new Error(
                  `The backtest didn't produce a result — ${detail}.` +
                    (logTail ? `\n\n${logTail.slice(-1200)}` : ''),
                ),
              );
            }
          }
        } else {
          const already = settle();
          if (!already) {
            rejectDone(
              new Error(
                `agent exited with code ${code}.` +
                  (logTail ? `\nlog tail:\n${logTail.slice(-1500)}` : ''),
              ),
            );
          }
        }
      })();
    });

    // ---- wire the abort signal ---------------------------------------------
    if (signal.aborted) {
      void interrupt();
    } else {
      signal.addEventListener('abort', onAbort);
    }

    return { interrupt, done };
  }
}
