// ============================================================================
// The Bun API server as a whole (server/index.ts), booted as a real process on
// scratch ports with the mock agent and an empty data dir. Covers what only an
// end-to-end pass can: the route table is wired, each listener applies ITS
// guard, cross-origin browsers are refused by default, and the phone views
// carry a finished run's figures.
// ============================================================================

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MobileStrategy, MobileStrategyRow, Session } from '@/lib/types';

const LOCAL_PORT = 18787;
const TAILNET_PORT = 18788;
const LOCAL = `http://127.0.0.1:${LOCAL_PORT}`;
const TAILNET = `http://127.0.0.1:${TAILNET_PORT}`;
const ALLOWED_ORIGIN = 'http://127.0.0.1:8765';

let server: ReturnType<typeof Bun.spawn>;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'hindsight-server-'));
  server = Bun.spawn(['bun', 'server/index.ts'], {
    cwd: path.resolve(import.meta.dir, '..'),
    env: {
      ...process.env,
      HINDSIGHT_AGENT: 'mock',
      HINDSIGHT_MOCK_SPEED: '40',
      HINDSIGHT_DATA_DIR: dataDir,
      HINDSIGHT_API_HOST: '127.0.0.1',
      HINDSIGHT_API_PORT: String(LOCAL_PORT),
      HINDSIGHT_TAILNET_PORT: String(TAILNET_PORT),
      HINDSIGHT_TAILNET_USERS: 'me@example.com',
      HINDSIGHT_CORS_ORIGINS: ALLOWED_ORIGIN,
      HINDSIGHT_AUTH_USER: '',
      HINDSIGHT_AUTH_PASSWORD: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${LOCAL}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(50);
  }
  throw new Error('The API server did not start.');
});

afterAll(async () => {
  server.kill();
  await server.exited;
  await rm(dataDir, { recursive: true, force: true });
});

const asTailnetUser = (login: string) => ({ headers: { 'tailscale-user-login': login } });

describe('the local listener', () => {
  test('serves the API to local callers', async () => {
    const res = await fetch(`${LOCAL}/api/sessions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('applies the tunnel gate itself: a public visitor gets only the share page', async () => {
    const viaTunnel = { headers: { 'x-forwarded-for': '203.0.113.9' } };
    expect((await fetch(`${LOCAL}/api/sessions`, viaTunnel)).status).toBe(404);
    expect((await fetch(`${LOCAL}/api/mobile/strategies`, viaTunnel)).status).toBe(404);
    // Reaches the share handler, which 404s the unknown token with its HTML page.
    const share = await fetch(`${LOCAL}/share/unknowntoken`, viaTunnel);
    expect(share.status).toBe(404);
    expect(share.headers.get('content-type')).toContain('text/html');
  });

  test('does not trust a Tailscale identity header', async () => {
    const res = await fetch(`${LOCAL}/api/sessions`, {
      headers: { 'x-forwarded-for': '203.0.113.9', 'tailscale-user-login': 'me@example.com' },
    });
    expect(res.status).toBe(404);
  });

  test('unknown paths are 404 JSON', async () => {
    const res = await fetch(`${LOCAL}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});

describe('cross-origin browsers', () => {
  test('get no CORS grant by default, and no preflight', async () => {
    const res = await fetch(`${LOCAL}/api/sessions`, { headers: { origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${LOCAL}/api/sessions`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(404);
  });

  test('a look-alike of an opted-in origin is not', async () => {
    for (const origin of [`${ALLOWED_ORIGIN}.evil.example`, 'http://127.0.0.1:9999', 'https://127.0.0.1:8765']) {
      const res = await fetch(`${LOCAL}/api/sessions`, { headers: { origin } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  test('an opted-in origin is allowed by name', async () => {
    const res = await fetch(`${LOCAL}/api/sessions`, { headers: { origin: ALLOWED_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const preflight = await fetch(`${LOCAL}/api/sessions`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
  });
});

describe('the tailnet listener', () => {
  test('refuses a request with no tailnet identity', async () => {
    const res = await fetch(`${TAILNET}/api/sessions`);
    expect(res.status).toBe(401);
  });

  test('refuses a tailnet user outside the allowlist', async () => {
    const res = await fetch(`${TAILNET}/api/sessions`, asTailnetUser('someone@else.example'));
    expect(res.status).toBe(403);
  });

  test('serves an allowed tailnet user, whatever the forwarding address', async () => {
    const res = await fetch(`${TAILNET}/api/sessions`, {
      headers: { 'tailscale-user-login': 'Me@Example.com', 'x-forwarded-for': '100.72.31.85' },
    });
    expect(res.status).toBe(200);
  });
});

describe('the phone views', () => {
  test('follow a strategy from running to its finished figures', async () => {
    const created = await fetch(`${TAILNET}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tailscale-user-login': 'me@example.com' },
      body: JSON.stringify({ prompt: 'Hold SPY and rebalance monthly, 2018 to 2023' }),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as Session;
    expect(session.status).toBe('running');

    const detailUrl = `${TAILNET}/api/mobile/strategies/${session.id}`;
    const running = (await (await fetch(detailUrl, asTailnetUser('me@example.com'))).json()) as MobileStrategy;
    expect(running.status).toBe('running');
    expect(running.hasResult).toBe(false);
    expect(running.statusLabel).not.toBe('');
    expect(running.messages[0]).toMatchObject({ role: 'user', text: session.prompt });

    let detail = running;
    for (let i = 0; i < 100 && detail.status === 'running'; i += 1) {
      await Bun.sleep(50);
      detail = (await (await fetch(detailUrl, asTailnetUser('me@example.com'))).json()) as MobileStrategy;
    }
    expect(detail.status).toBe('done');
    expect(detail.hasResult).toBe(true);
    expect(detail.returnText).toMatch(/^[+−]\d+\.\d%$/);
    expect(detail.valueText).toMatch(/^\$[\d,]+\.\d{2}$/);
    expect(detail.changeText).toMatch(/^[+−]\$[\d,]+\.\d{2}$/);
    expect(detail.metaText).toBe('2018–2023 · $10,000 start');
    expect(detail.chartLine.startsWith('M0.0,')).toBe(true);
    expect(detail.chartArea.endsWith(' Z')).toBe(true);
    expect(detail.steps).toEqual([]);
    expect(detail.statusLabel).toBe('');
    expect(detail.messages.some((m) => m.role === 'agent')).toBe(true);

    const rows = (await (await fetch(`${LOCAL}/api/mobile/strategies`)).json()) as MobileStrategyRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: session.id, status: 'done', returnText: detail.returnText });
    expect(rows[0].spark.startsWith('M0.0,')).toBe(true);
    // A row is a row: none of the detail-only fields ride along.
    expect('messages' in rows[0]).toBe(false);
  });

  test('an unknown strategy is a 404', async () => {
    const res = await fetch(`${LOCAL}/api/mobile/strategies/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
