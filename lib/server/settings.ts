// ============================================================================
// App settings — a single JSON file at `${data}/settings.json`, written
// atomically like the session store (tmp file + rename). Holds the model and
// reasoning effort used for LLM-backed runs (initial/refine).
//
// Precedence for the model: settings.json > HINDSIGHT_CODEX_MODEL > built-in
// default. The env var keeps working as the default for installs that never
// open the settings dialog; once the dialog saves, the file wins.
// ============================================================================

import { readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { CODEX_EFFORTS, type AppSettings, type UpdateSettingsBody } from '@/lib/types';
import { dataDir, ensureDir } from './paths';

const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT: AppSettings['effort'] = 'medium';

/** `${data}/settings.json`. */
export function settingsFile(): string {
  return path.join(dataDir(), 'settings.json');
}

function defaults(): AppSettings {
  const envModel = process.env.HINDSIGHT_CODEX_MODEL?.trim();
  return { model: envModel || DEFAULT_MODEL, effort: DEFAULT_EFFORT };
}

/**
 * Coerce whatever was on disk into a valid AppSettings. Any non-empty model
 * string is kept (a hand-edited file may name a model the dialog doesn't
 * offer); an unknown effort falls back to the default rather than reaching
 * `codex exec` and failing the run there.
 */
function normalize(raw: unknown): AppSettings {
  const d = defaults();
  if (!raw || typeof raw !== 'object') return d;
  const j = raw as { model?: unknown; effort?: unknown };
  return {
    model: typeof j.model === 'string' && j.model.trim() ? j.model.trim() : d.model,
    effort: CODEX_EFFORTS.includes(j.effort as AppSettings['effort']) ? (j.effort as AppSettings['effort']) : d.effort,
  };
}

/** Current settings; a missing or unreadable file yields the defaults. */
export async function getSettings(): Promise<AppSettings> {
  try {
    return normalize(JSON.parse(await readFile(settingsFile(), 'utf8')));
  } catch {
    return defaults();
  }
}

/** Sync variant for AgentRunner.start(), which is synchronous by contract. */
export function getSettingsSync(): AppSettings {
  try {
    return normalize(JSON.parse(readFileSync(settingsFile(), 'utf8')));
  } catch {
    return defaults();
  }
}

/** Merge a validated patch over the current settings and persist atomically. */
export async function updateSettings(patch: UpdateSettingsBody): Promise<AppSettings> {
  const next = normalize({ ...(await getSettings()), ...patch });
  await ensureDir(dataDir());
  const file = settingsFile();
  const tmp = `${file}.${nanoid()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return next;
}
