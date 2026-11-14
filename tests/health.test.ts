// Agent readiness (lib/server/agent/health.ts, PROTOCOL.md §6). When this
// returns ready:false the composer is disabled and the two LLM-backed endpoints
// refuse with 503 — so a false "ready" means runs that only fail deep inside
// Docker, and a false "not ready" locks the user out of their own app.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAgentHealth, getProviderHealth, invalidateAgentHealth } from '@/lib/server/agent/health';
import { withTempDataDir } from './helpers';

let codexHome = '';
const saved: Record<string, string | undefined> = {};

// With no model named, readiness is asked of the app-wide model's agent, so
// the settings these tests see must be their own: an empty data directory
// (the default model, a Codex one) and no Claude credential.
withTempDataDir();

beforeAll(async () => {
  for (const key of ['HINDSIGHT_AGENT', 'HINDSIGHT_CODEX_HOME', 'HINDSIGHT_CODEX_MODEL', 'HINDSIGHT_CLAUDE_TOKEN_FILE']) {
    saved[key] = process.env[key];
  }
  codexHome = await mkdtemp(path.join(tmpdir(), 'hindsight-codex-'));
  process.env.HINDSIGHT_CODEX_HOME = codexHome;
  delete process.env.HINDSIGHT_CODEX_MODEL;
  process.env.HINDSIGHT_CLAUDE_TOKEN_FILE = path.join(codexHome, 'claude-token');
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(codexHome, { recursive: true, force: true });
  invalidateAgentHealth();
});

beforeEach(() => {
  invalidateAgentHealth();
});

afterEach(async () => {
  await rm(path.join(codexHome, 'auth.json'), { force: true });
  invalidateAgentHealth();
});

const writeAuth = (contents: string) =>
  writeFile(path.join(codexHome, 'auth.json'), contents, 'utf8');

describe('mock mode', () => {
  test.each([[undefined], ['mock'], ['something-else']])(
    'HINDSIGHT_AGENT=%p is always ready and needs no credentials',
    async (value) => {
      if (value === undefined) delete process.env.HINDSIGHT_AGENT;
      else process.env.HINDSIGHT_AGENT = value;
      invalidateAgentHealth();

      expect(await getAgentHealth()).toEqual({
        agent: 'mock',
        ready: true,
        reason: null,
        hint: null,
        codexHome: null,
      });
    },
  );
});

describe('codex mode', () => {
  beforeEach(() => {
    process.env.HINDSIGHT_AGENT = 'codex';
    invalidateAgentHealth();
  });

  test('an API key in auth.json is a usable credential', async () => {
    await writeAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }));
    const health = await getAgentHealth();

    expect(health.ready).toBe(true);
    expect(health.agent).toBe('codex');
    expect(health.reason).toBeNull();
    expect(health.codexHome).toBe(codexHome);
  });

  test('an OAuth access token is equally usable', async () => {
    await writeAuth(JSON.stringify({ tokens: { access_token: 'ya29.test' } }));
    expect((await getAgentHealth()).ready).toBe(true);
  });

  test('a missing auth.json reports "not signed in" with the login hint', async () => {
    const health = await getAgentHealth();

    expect(health.ready).toBe(false);
    expect(health.reason).toBe('Codex is not signed in on this machine.');
    expect(health.hint).toContain('codex login');
    expect(health.hint).toContain(codexHome);
    expect(health.codexHome).toBe(codexHome);
  });

  test.each([
    ['{ not json', 'unparseable'],
    ['null', 'null'],
    ['"a string"', 'a bare string'],
    ['{}', 'an empty object'],
    ['{"OPENAI_API_KEY":""}', 'an empty key'],
    ['{"OPENAI_API_KEY":"   "}', 'a whitespace key'],
    ['{"OPENAI_API_KEY":123}', 'a non-string key'],
    ['{"tokens":{}}', 'no access token'],
    ['{"tokens":{"access_token":""}}', 'an empty access token'],
  ])('auth.json containing %p (%s) is not a credential', async (contents) => {
    await writeAuth(contents);
    const health = await getAgentHealth();

    expect(health.ready).toBe(false);
    expect(health.reason).toBe('Codex credentials on this machine are unreadable.');
    expect(health.hint).toContain('codex login');
  });
});

describe('caching', () => {
  test('a fresh login is picked up once the cache is invalidated', async () => {
    process.env.HINDSIGHT_AGENT = 'codex';
    invalidateAgentHealth();
    expect((await getAgentHealth()).ready).toBe(false);

    // The user runs `codex login` in a terminal...
    await writeAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }));

    // ...the cached answer is still the old one within the TTL,
    expect((await getAgentHealth()).ready).toBe(false);
    // ...and invalidating (what the tab-focus re-check does) sees the new state.
    invalidateAgentHealth();
    expect((await getAgentHealth()).ready).toBe(true);
  });
});

describe('Claude Code', () => {
  const tokenFile = () => path.join(codexHome, 'claude-token');
  afterEach(async () => {
    await rm(tokenFile(), { force: true });
  });

  test('a Claude model is ready only with Claude’s credential, whatever Codex has', async () => {
    process.env.HINDSIGHT_AGENT = 'codex';
    await writeAuth(JSON.stringify({ OPENAI_API_KEY: 'sk-test' }));
    invalidateAgentHealth();

    const missing = await getAgentHealth('claude-opus-5-5');
    expect(missing.ready).toBe(false);
    expect(missing.provider).toBe('claude');
    expect(missing.reason).toBe('Claude Code is not signed in on this machine.');
    expect(missing.hint).toContain('claude setup-token');
    // The same moment, a Codex model can run.
    expect((await getAgentHealth('gpt-5.6-terra')).ready).toBe(true);

    await writeFile(tokenFile(), 'sk-ant-oat01-test\n', 'utf8');
    invalidateAgentHealth();
    const present = await getAgentHealth('claude-opus-5-5');
    expect(present.ready).toBe(true);
    expect(present.provider).toBe('claude');
  });

  test('an empty credential file is not a credential', async () => {
    process.env.HINDSIGHT_AGENT = 'codex';
    await writeFile(tokenFile(), '  \n', 'utf8');
    invalidateAgentHealth();
    expect((await getProviderHealth('claude')).ready).toBe(false);
  });

  test('the mock agent needs neither', async () => {
    process.env.HINDSIGHT_AGENT = 'mock';
    invalidateAgentHealth();
    expect((await getAgentHealth('claude-opus-5-5')).ready).toBe(true);
  });
});
