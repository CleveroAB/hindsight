// The app's local server: the real Hindsight API (../server) with the mock agent, on a
// scratch data directory, where app.ts looks when no API_BASE_URL was built in.
//
//   bun server.ts          for the dev loop (`bun exact.mjs web`): data under .exact/dev-data
//   test, verify           start it themselves, told a scratch DB path and a PORT; each run
//                          gets an empty data directory beside that path
//
// It is a harness, not a deployment: the mock agent plays its run a thousand times faster
// so a test never waits in real time, the benchmark's prices are made up here instead of
// fetched, and (on a scratch DB only) two routes let a test empty the store and wait for
// runs in flight. The phone talks to `bun run api`.
import path from 'node:path';
import { API } from './app.ts';

const scratch = process.env.DB ?? '';
const testing = scratch.includes('.exact');

process.env.HINDSIGHT_AGENT = 'mock';
process.env.HINDSIGHT_DATA_DIR = scratch ? `${scratch}.data` : path.join(import.meta.dir, '.exact', 'dev-data');
process.env.HINDSIGHT_API_HOST = '127.0.0.1';
process.env.HINDSIGHT_API_PORT = process.env.PORT ?? new URL(API).port;
process.env.HINDSIGHT_TAILNET_PORT = '';
// No front-door auth and no real signal delivery, whatever the repo's .env.local says.
process.env.HINDSIGHT_AUTH_USER = '';
process.env.HINDSIGHT_AUTH_PASSWORD = '';
process.env.HINDSIGHT_SIGNAL_PROVIDER = 'webhook';
process.env.HINDSIGHT_SIGNAL_WEBHOOK_URL = '';
// The Exact web host's page is another origin, on a port of its choosing: allow pages
// served from this machine (and nothing else) to call this mock-agent harness.
process.env.HINDSIGHT_CORS_ORIGINS = 'loopback';
if (testing) process.env.HINDSIGHT_MOCK_SPEED = '1000';

// A test's comparison never leaves this machine: the benchmark's price history (Yahoo's
// chart endpoint, see lib/server/benchmark) is answered here with a straight line that
// gains 50% over whatever period is asked for, one close per weekday.
if (testing) {
  const real = globalThis.fetch;
  const prices = (url: URL): Response => {
    const from = Number(url.searchParams.get('period1'));
    const to = Number(url.searchParams.get('period2'));
    const timestamp: number[] = [];
    const adjclose: number[] = [];
    for (let t = from; t <= to; t += 86400) {
      const day = new Date(t * 1000).getUTCDay();
      if (day === 0 || day === 6) continue;
      timestamp.push(t);
      adjclose.push(100 * (1 + 0.5 * ((t - from) / Math.max(1, to - from))));
    }
    return Response.json({ chart: { result: [{ timestamp, indicators: { adjclose: [{ adjclose }] } }] } });
  };
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof real>[0], init?: Parameters<typeof real>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === 'query1.finance.yahoo.com' ? Promise.resolve(prices(url)) : real(input, init);
    },
    real,
  );
}

const { ROUTES } = await import('../server/router');

if (testing) {
  const { listSessions, deleteSession } = await import('../lib/server/store');
  const { runManager } = await import('../lib/server/runManager');
  const anyRunning = async () => (await listSessions()).some((s) => s.status === 'running' || runManager.isActive(s.id));

  // Answers once no backtest is in flight, so the next read sees finished results.
  ROUTES['/test/settle'] = {
    POST: async () => {
      for (let i = 0; i < 400 && (await anyRunning()); i += 1) await Bun.sleep(5);
      return Response.json({ ok: !(await anyRunning()) });
    },
  };
  // Empties the store: a test that counts strategies starts from none.
  ROUTES['/test/reset'] = {
    POST: async () => {
      for (const session of await listSessions()) {
        if (runManager.isActive(session.id)) await runManager.interrupt(session.id);
        await deleteSession(session.id);
      }
      return Response.json({ ok: true });
    },
  };
}

await import('../server/index');
