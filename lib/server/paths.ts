// ============================================================================
// Filesystem path helpers for the session store + per-session agent workdirs.
// Everything hangs off HINDSIGHT_DATA_DIR (default `<repo>/data`). See
// PROTOCOL.md §1 for the on-disk layout.
// Server-only: uses node:fs / node:path.
// ============================================================================

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * True for ids that are safe to interpolate into filesystem paths. Rejects
 * anything with `.`, `/`, or path-traversal sequences so a request can't escape
 * the data dir. Legit nanoid ids (URL-safe alphabet) always match.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Absolute root for all persisted data. Honors HINDSIGHT_DATA_DIR. */
export function dataDir(): string {
  const env = process.env.HINDSIGHT_DATA_DIR;
  if (env && env.trim()) {
    return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  }
  return path.join(process.cwd(), 'data');
}

/** `${data}/sessions` — one `<id>.json` per session. */
export function sessionsDir(): string {
  return path.join(dataDir(), 'sessions');
}

/** `${data}/sessions/<id>.json`. */
export function sessionFile(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

/** `${data}/work/<id>` — the agent's working directory for this session. */
export function workDir(id: string): string {
  return path.join(dataDir(), 'work', id);
}

/** `${data}/work/<id>/data` — cached/snapshotted fetched data (cleared on refresh). */
export function workDataDir(id: string): string {
  return path.join(workDir(id), 'data');
}

/**
 * `${data}/work/<id>/uploads` — images attached to chat messages. Deliberately
 * a sibling of `data/` (not inside it) so a "refresh data" run, which wipes the
 * price snapshot, never destroys what the user sent. Inside the workdir, so the
 * agent container sees them at `/work/uploads/`.
 */
export function uploadsDir(id: string): string {
  return path.join(workDir(id), 'uploads');
}

/**
 * `${data}/work/<id>/uploads/<name>`, or null if `name` isn't a plain
 * server-generated upload filename. Rejects traversal, absolute paths, and
 * anything that would resolve outside the uploads dir.
 */
export function uploadFile(id: string, name: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,5}$/.test(name)) return null;
  const dir = uploadsDir(id);
  const full = path.join(dir, name);
  // Belt and braces: the regex already excludes separators and `..`.
  if (path.dirname(full) !== dir) return null;
  return full;
}

/** `${data}/work/<id>/params.json`. */
export function paramsFile(id: string): string {
  return path.join(workDir(id), 'params.json');
}

/** `${data}/work/<id>/strategy.py`. */
export function strategyFile(id: string): string {
  return path.join(workDir(id), 'strategy.py');
}

/** `${data}/work/<id>/events.ndjson`. */
export function eventsFile(id: string): string {
  return path.join(workDir(id), 'events.ndjson');
}

/** `${data}/work/<id>/result.json`. */
export function resultFile(id: string): string {
  return path.join(workDir(id), 'result.json');
}

/** `${data}/work/<id>/agent.log`. */
export function agentLogFile(id: string): string {
  return path.join(workDir(id), 'agent.log');
}

/** Recursively create a directory (no-op if it already exists). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Ensure the sessions directory exists. */
export async function ensureSessionsDir(): Promise<void> {
  await ensureDir(sessionsDir());
}

/** Ensure a session's working directory exists; returns its absolute path. */
export async function ensureWorkDir(id: string): Promise<string> {
  const dir = workDir(id);
  await ensureDir(dir);
  return dir;
}
