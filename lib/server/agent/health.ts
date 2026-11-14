// ============================================================================
// Agent readiness. In 'codex' mode a run only works if the host has Codex CLI
// credentials — the container copies $HINDSIGHT_CODEX_HOME/auth.json into its
// own CODEX_HOME (see docker/entrypoint.sh). Without it `codex exec` fails
// deep inside the container and the user only ever sees a generic run failure.
// Checking the file up front lets the API refuse cleanly and the UI say why.
//
// 'mock' mode needs no credentials and is always ready.
//
// Readiness is asked per agent: a run on a Claude model needs Claude Code's
// credential (lib/server/models `claudeTokenFile()`), not Codex's. With no
// model named, the answer is about the app-wide model's agent.
// ============================================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import type { AgentHealth, AgentProvider } from '@/lib/types';
import { claudeSignedIn, claudeTokenFile, providerOf } from '@/lib/server/models';
import { getSettings } from '@/lib/server/settings';

const DEFAULT_CODEX_HOME = '~/.codex';
/** Re-stat at most this often; the home page polls, and this hits the disk. */
const CACHE_TTL_MS = 5000;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function ok(agent: AgentHealth['agent'], codexHome: string | null, provider?: AgentProvider): AgentHealth {
  return { agent, ready: true, reason: null, hint: null, codexHome, ...(provider ? { provider } : {}) };
}

function notReady(reason: string, hint: string, codexHome: string): AgentHealth {
  return { agent: 'codex', ready: false, reason, hint, codexHome, provider: 'codex' };
}

/** True if auth.json actually carries a usable credential. */
function hasCredential(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const j = parsed as { OPENAI_API_KEY?: unknown; tokens?: { access_token?: unknown } };
  if (typeof j.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY.trim().length > 0) return true;
  const token = j.tokens?.access_token;
  return typeof token === 'string' && token.trim().length > 0;
}

const cached = new Map<AgentProvider, { at: number; value: AgentHealth }>();

async function computeClaude(): Promise<AgentHealth> {
  if (await claudeSignedIn()) return ok('codex', null, 'claude');
  return {
    agent: 'codex',
    ready: false,
    reason: 'Claude Code is not signed in on this machine.',
    hint: `No credential at ${claudeTokenFile()}. Run \`claude setup-token\` and save the token there, then reload.`,
    codexHome: null,
    provider: 'claude',
  };
}

async function compute(provider: AgentProvider): Promise<AgentHealth> {
  if (provider === 'claude') return computeClaude();

  const codexHome = expandHome(process.env.HINDSIGHT_CODEX_HOME || DEFAULT_CODEX_HOME);
  const authPath = path.join(codexHome, 'auth.json');

  let raw: string;
  try {
    raw = await readFile(authPath, 'utf8');
  } catch {
    return notReady(
      'Codex is not signed in on this machine.',
      `No credentials at ${authPath}. Run \`codex login\` in a terminal, then reload.`,
      codexHome,
    );
  }

  if (!hasCredential(raw)) {
    return notReady(
      'Codex credentials on this machine are unreadable.',
      `${authPath} has no API key or access token. Run \`codex login\` again, then reload.`,
      codexHome,
    );
  }

  return ok('codex', codexHome, 'codex');
}

/** One agent's readiness (cached for a few seconds). Always ready with the mock agent. */
export async function getProviderHealth(provider: AgentProvider): Promise<AgentHealth> {
  if (process.env.HINDSIGHT_AGENT !== 'codex') return ok('mock', null);
  const now = Date.now();
  const hit = cached.get(provider);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await compute(provider);
  cached.set(provider, { at: now, value });
  return value;
}

/**
 * Can a run on `model` start right now? With no model named, the app-wide
 * one (lib/server/settings) is asked about.
 */
export async function getAgentHealth(model?: string | null): Promise<AgentHealth> {
  if (process.env.HINDSIGHT_AGENT !== 'codex') return ok('mock', null);
  return getProviderHealth(providerOf(model || (await getSettings()).model));
}

/** Forget the cached result — used after a failed run so a fresh login shows up. */
export function invalidateAgentHealth(): void {
  cached.clear();
}
