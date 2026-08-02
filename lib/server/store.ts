// ============================================================================
// Session store — async JSON persistence over fs/promises with ATOMIC writes
// (write a unique tmp file, then rename over the target). One file per session
// at `${data}/sessions/<id>.json`. See PROTOCOL.md §1.
//
// "Persist results only": the run manager keeps live progress in memory; only
// completed session state (status/result/chat/meta) is written here. On boot,
// any session still marked `running` is rewritten to `failed` (no reattach).
// ============================================================================

import { readFile, writeFile, rename, readdir, unlink, rm } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { Attachment, ChatMessage, Period, Session, SignalCadence } from '@/lib/types';
import { ensureBacktestHistory } from '@/lib/backtests';
import { parsePeriodFromPrompt } from '@/lib/period';
import { ensureDir, sessionFile, sessionsDir, signalWorkDir, workDir } from './paths';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Today's date as `YYYY-MM-DD` in local time. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Default backtest window: the last ~10 calendar years up to today. */
function defaultPeriod(): Period {
  const year = new Date().getFullYear();
  return { start: `${year - 10}-01-01`, end: todayIso() };
}

const SIGNAL_CADENCES: readonly SignalCadence[] = ['hourly', 'daily', 'weekly', 'monthly'];

/**
 * Defensively hydrate `activation` on read (same spirit as
 * ensureBacktestHistory): a hand-edited or partially written value that is not
 * an object carrying every required key is coerced to undefined (= inactive)
 * rather than crashing the scheduler or the UI. Mutates and returns the session.
 */
function normalizeActivation(session: Session): Session {
  const raw = session.activation as unknown;
  if (raw == null) return session; // absent and explicit null both mean inactive
  const a = raw as Record<string, unknown>;
  const valid =
    typeof raw === 'object' &&
    typeof a.phone === 'string' &&
    a.phone.trim() !== '' &&
    typeof a.activatedAt === 'number' &&
    SIGNAL_CADENCES.includes(a.cadence as SignalCadence) &&
    typeof a.cadenceReason === 'string' &&
    typeof a.nextCheckAt === 'number' &&
    (a.lastCheckAt === null || typeof a.lastCheckAt === 'number') &&
    (a.lastSignal === null || (typeof a.lastSignal === 'object' && a.lastSignal !== null)) &&
    (a.lastError === null || typeof a.lastError === 'string');
  if (!valid) delete session.activation;
  return session;
}

/** All read-path hydration in one place. */
function hydrateSession(raw: string): Session {
  return normalizeActivation(ensureBacktestHistory(JSON.parse(raw) as Session));
}

/** Write a session JSON atomically: tmp file + rename (never a partial file). */
async function writeSessionAtomic(session: Session): Promise<void> {
  await ensureDir(sessionsDir());
  const file = sessionFile(session.id);
  const tmp = `${file}.${nanoid()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/** All sessions, newest-first by `createdAt`. Corrupt/unreadable files are skipped. */
export async function listSessions(): Promise<Session[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const sessions: Session[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    try {
      const raw = await readFile(sessionFile(id), 'utf8');
      sessions.push(hydrateSession(raw));
    } catch {
      // Skip partial writes / corrupt files rather than break the whole list.
    }
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  return sessions;
}

/** Load one session, or null if it does not exist. */
export async function getSession(id: string): Promise<Session | null> {
  try {
    const raw = await readFile(sessionFile(id), 'utf8');
    return hydrateSession(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Persist a session, stamping `updatedAt`. Returns the same object. */
export async function saveSession(session: Session): Promise<Session> {
  ensureBacktestHistory(session);
  session.updatedAt = Date.now();
  await writeSessionAtomic(session);
  return session;
}

export interface CreateSessionInput {
  prompt: string;
  period?: Partial<Period>;
  startingCapital?: number;
  /**
   * Images attached to the opening prompt. Recorded on the first chat message;
   * the caller writes the bytes into the session's uploads dir afterwards
   * (the names are already assigned, so this doesn't need the id first).
   */
  attachments?: Attachment[];
}

/**
 * Create a new session from a prompt and persist it at `status: 'running'`,
 * seeded with the prompt as the first (user) chat message. The actual run is
 * kicked off by the run manager after this returns.
 */
export async function createSession(input: CreateSessionInput): Promise<Session> {
  const now = Date.now();
  const prompt = input.prompt;
  const base = defaultPeriod();
  // When the caller supplied no explicit period, infer one from the prompt
  // (e.g. "2016 to 2025"). Parsed sides win; any missing side falls back to the
  // computed default. Explicit periods keep the original merge behaviour.
  const hasExplicitPeriod = Boolean(input.period?.start || input.period?.end);
  const parsed = hasExplicitPeriod ? null : parsePeriodFromPrompt(prompt);
  const period: Period = {
    start: input.period?.start ?? parsed?.start ?? base.start,
    end: input.period?.end ?? parsed?.end ?? base.end,
  };
  const session: Session = {
    id: nanoid(),
    name: '',
    description: '',
    prompt,
    period,
    startingCapital: input.startingCapital ?? 10000,
    status: 'running',
    result: null,
    chat: [
      {
        id: nanoid(),
        role: 'user',
        text: prompt,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        createdAt: now,
      },
    ],
    backtests: [],
    dataSnapshotAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeSessionAtomic(session);
  return session;
}

/**
 * Find the session carrying this share token, or null. A linear scan over all
 * session files — fine at local scale (dozens of strategies), and it avoids a
 * second index that could drift from the store.
 */
export async function findSessionByShareToken(token: string): Promise<Session | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return null;
  const sessions = await listSessions();
  return sessions.find((s) => s.shareToken === token) ?? null;
}

/** Delete a session file, its working directory, and any signal scratch dir. */
export async function deleteSession(id: string): Promise<void> {
  try {
    await unlink(sessionFile(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  await rm(workDir(id), { recursive: true, force: true });
  await rm(signalWorkDir(id), { recursive: true, force: true });
}

/** Append a chat message to a session and persist. Null if the session is gone. */
export async function appendChat(id: string, msg: ChatMessage): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;
  session.chat.push(msg);
  await saveSession(session);
  return session;
}

/**
 * Boot cleanup: any session left `running` (a run that was in flight when the
 * server stopped) is flipped to `failed` — we do not reattach to in-flight runs.
 */
/**
 * Fail sessions left `running` by a process that is no longer alive.
 *
 * Liveness is inferred from `updatedAt`: the run manager heartbeats every active
 * run (see HEARTBEAT_MS), so a run whose session hasn't been touched in
 * `staleMs` has no owner. Reaping unconditionally would be wrong — `next dev`
 * re-evaluates server modules (and can serve from more than one instance), so a
 * second initialisation would otherwise kill a backtest that is still running,
 * flipping it to `failed` while its container keeps going.
 *
 * `isOwnedHere` lets the caller protect runs this process is actively driving,
 * regardless of heartbeat timing.
 */
export async function markOrphanedRunningFailed(
  staleMs: number,
  isOwnedHere: (id: string) => boolean = () => false,
): Promise<string[]> {
  const sessions = await listSessions();
  const reaped: string[] = [];
  const now = Date.now();
  for (const session of sessions) {
    if (session.status !== 'running') continue;
    if (isOwnedHere(session.id)) continue;
    if (now - session.updatedAt < staleMs) continue; // still heartbeating
    session.status = 'failed';
    await saveSession(session);
    reaped.push(session.id);
  }
  return reaped;
}
