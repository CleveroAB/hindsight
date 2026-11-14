// ============================================================================
// The models a run may use — asked of Codex itself, not listed here.
//
// `codex debug models` prints the catalog the signed-in account is offered
// (it is what the CLI's own model picker shows), so the settings UIs offer
// exactly what `codex exec -m <id>` will accept on this machine. Order of
// preference:
//
//   1. `codex debug models`            the host CLI ($HINDSIGHT_CODEX_BIN, else
//                                      `codex` on PATH, else ~/.local/bin/codex)
//   2. `$CODEX_HOME/models_cache.json` the same catalog as the CLI last cached
//                                      it, for hosts with credentials but no CLI
//   3. CODEX_MODELS                    the built-in list, when Codex can't be
//                                      asked at all (e.g. mock mode on a laptop)
//
// Only models Codex marks for listing are offered; its internal ones (review,
// reserve) are not choices.
//
// Claude Code is the second agent. It has no catalog command, so its models
// are asked of Anthropic's Models API with the same credential the container
// runs on (`claudeTokenFile()`), newest of each family first. With no
// credential there are no Claude models to offer.
// ============================================================================

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CODEX_EFFORTS,
  CODEX_MODELS,
  type AgentProvider,
  type CodexEffort,
  type CodexModelInfo,
  type ModelsResponse,
} from '@/lib/types';

const DEFAULT_CODEX_HOME = '~/.codex';
/** The catalog changes when the account or CLI does — rarely. */
const CACHE_TTL_MS = 60_000;
const CLI_TIMEOUT_MS = 8000;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** Efforts `claude --effort` accepts, weakest first. */
const CLAUDE_EFFORTS: CodexEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Offered when the Models API can't be reached but a credential exists. */
const CLAUDE_FALLBACK: Array<[string, string]> = [
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
];
const DEFAULT_CLAUDE_TOKEN_FILE = '~/.config/hindsight/claude-oauth-token';

/**
 * Where Claude Code's credential lives on the host: one line, either a
 * `claude setup-token` token or an Anthropic API key. Mounted read-only into
 * the agent container, which exports it under the right name.
 */
export function claudeTokenFile(): string {
  return expandHome(process.env.HINDSIGHT_CLAUDE_TOKEN_FILE?.trim() || DEFAULT_CLAUDE_TOKEN_FILE);
}

/** The agent that runs `model`. Sync and offline: a Claude model's id says so. */
export function providerOf(model: string): AgentProvider {
  return model.startsWith('claude') ? 'claude' : 'codex';
}

/** The effort to hand an agent for `model`: Claude Code has no `minimal`. */
export function effortFor(model: string, effort: CodexEffort): CodexEffort {
  return providerOf(model) === 'claude' && effort === 'minimal' ? 'low' : effort;
}

function codexHome(): string {
  return expandHome(process.env.HINDSIGHT_CODEX_HOME || DEFAULT_CODEX_HOME);
}

/** `gpt-5.6-terra` → `GPT-5.6-Terra`, for a catalog entry without a display name. */
function titleOf(id: string): string {
  return id
    .split('-')
    .map((part) => (part === 'gpt' ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-');
}

/**
 * Codex's raw catalog (`{ models: [...] }`) as the choices to offer. Pure —
 * exported for tests. Entries without a slug, and those Codex hides from its
 * own picker, are dropped; efforts Hindsight can't pass through are too.
 */
export function parseCatalog(raw: unknown): CodexModelInfo[] {
  const list = (raw as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  const models: Array<CodexModelInfo & { priority: number }> = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const m = entry as {
      slug?: unknown;
      display_name?: unknown;
      description?: unknown;
      visibility?: unknown;
      priority?: unknown;
      default_reasoning_level?: unknown;
      supported_reasoning_levels?: unknown;
    };
    if (typeof m.slug !== 'string' || !m.slug.trim()) continue;
    if (m.visibility !== undefined && m.visibility !== 'list') continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const efforts = levels
      .map((level) => (level as { effort?: unknown })?.effort)
      .filter((effort): effort is CodexEffort => CODEX_EFFORTS.includes(effort as CodexEffort));
    const defaultEffort = CODEX_EFFORTS.includes(m.default_reasoning_level as CodexEffort)
      ? (m.default_reasoning_level as CodexEffort)
      : 'medium';
    models.push({
      provider: 'codex',
      id: m.slug.trim(),
      name: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : titleOf(m.slug.trim()),
      description: typeof m.description === 'string' ? m.description.trim() : '',
      efforts: efforts.length > 0 ? efforts : [...CODEX_EFFORTS],
      defaultEffort,
      priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER,
    });
  }
  models.sort((a, b) => a.priority - b.priority);
  return models.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    description: m.description,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
  }));
}

function builtin(): CodexModelInfo[] {
  return CODEX_MODELS.map((id) => ({
    provider: 'codex' as const,
    id,
    name: titleOf(id),
    description: '',
    efforts: [...CODEX_EFFORTS],
    defaultEffort: 'medium' as const,
  }));
}

function run(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['debug', 'models'],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CODEX_HOME: codexHome() } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

async function fromCli(): Promise<CodexModelInfo[]> {
  const candidates = [process.env.HINDSIGHT_CODEX_BIN?.trim(), 'codex', path.join(homedir(), '.local', 'bin', 'codex')];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const models = parseCatalog(JSON.parse(await run(bin)));
      if (models.length > 0) return models;
    } catch {
      // Not installed here, not signed in, or an older CLI: try the next source.
    }
  }
  return [];
}

async function fromCache(): Promise<CodexModelInfo[]> {
  try {
    return parseCatalog(JSON.parse(await readFile(path.join(codexHome(), 'models_cache.json'), 'utf8')));
  } catch {
    return [];
  }
}

/** `claude-opus-5-5` → `opus`; `claude-haiku-4-5-20251001` → `haiku`. */
function familyOf(id: string): string {
  return id.replace(/^claude-/, '').split('-')[0];
}

/**
 * Anthropic's model list (`{ data: [{ id, display_name }] }`, newest first) as
 * the Claude choices: the newest model of each family. Pure — exported for tests.
 */
export function parseClaudeModels(raw: unknown): CodexModelInfo[] {
  const list = (raw as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const models: CodexModelInfo[] = [];
  for (const entry of list) {
    const m = entry as { id?: unknown; display_name?: unknown };
    if (typeof m?.id !== 'string' || !m.id.startsWith('claude-')) continue;
    const family = familyOf(m.id);
    if (seen.has(family)) continue;
    seen.add(family);
    models.push({
      provider: 'claude',
      id: m.id,
      name: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim() : titleOf(m.id),
      description: '',
      efforts: [...CLAUDE_EFFORTS],
      defaultEffort: 'medium',
    });
  }
  return models;
}

async function claudeToken(): Promise<string | null> {
  try {
    const token = (await readFile(claudeTokenFile(), 'utf8')).trim();
    return token || null;
  } catch {
    return null;
  }
}

/** True when a Claude credential is saved on this machine. */
export async function claudeSignedIn(): Promise<boolean> {
  return (await claudeToken()) !== null;
}

async function claudeModels(): Promise<CodexModelInfo[]> {
  const token = await claudeToken();
  if (!token) return [];
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: token.startsWith('sk-ant-api')
        ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
    });
    if (res.ok) {
      const models = parseClaudeModels(await res.json());
      if (models.length > 0) return models;
    }
  } catch {
    // Offline, or the API is down: the credential is still there, so offer
    // the names Claude Code itself knows.
  }
  return CLAUDE_FALLBACK.map(([id, name]) => ({
    provider: 'claude' as const,
    id,
    name,
    description: '',
    efforts: [...CLAUDE_EFFORTS],
    defaultEffort: 'medium' as const,
  }));
}

let cached: { at: number; value: ModelsResponse } | null = null;

/** The models to offer, and where the list came from (cached for a minute). */
export async function listModels(): Promise<ModelsResponse> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value: ModelsResponse;
  if (process.env.HINDSIGHT_AGENT !== 'codex') {
    // The mock agent calls no model; offer the built-in names so the settings
    // UIs have something to show, without touching a Codex install.
    value = { models: builtin(), source: 'builtin' };
  } else {
    const cli = await fromCli();
    if (cli.length > 0) value = { models: cli, source: 'codex' };
    else {
      const cache = await fromCache();
      value = cache.length > 0 ? { models: cache, source: 'cache' } : { models: builtin(), source: 'builtin' };
    }
    value = { models: [...value.models, ...(await claudeModels())], source: value.source };
  }
  cached = { at: Date.now(), value };
  return value;
}

/** True when `id` is one of the models on offer. */
export async function isOfferedModel(id: unknown): Promise<boolean> {
  if (typeof id !== 'string') return false;
  return (await listModels()).models.some((m) => m.id === id);
}

/** Test seam: forget the cached catalog. */
export function resetModelsCache(): void {
  cached = null;
}
