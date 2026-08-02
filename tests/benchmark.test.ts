// ============================================================================
// Benchmark selection + curve building (lib/server/benchmark.ts, PROTOCOL §6).
//
// Ticker inference is pure and gets the bulk of the coverage. The fetch path is
// exercised against a stubbed Yahoo response so the scaling contract ("scaled to
// the session's starting capital") is pinned without hitting the network.
// ============================================================================

import { afterEach, describe, expect, test } from 'bun:test';
import type { Period } from '@/lib/types';
import {
  DEFAULT_BENCHMARK,
  benchmarkCurve,
  inferBenchmarkTicker,
  isValidTicker,
} from '@/lib/server/benchmark';
import { makeSession } from './helpers';

const infer = (patch: { name?: string; prompt?: string; description?: string }): string =>
  inferBenchmarkTicker(makeSession({ name: '', prompt: '', description: '', ...patch }));

describe('inferBenchmarkTicker', () => {
  test('the broad market is the default', () => {
    expect(DEFAULT_BENCHMARK).toBe('SPY');
    expect(infer({ prompt: 'buy the dip every friday' })).toBe('SPY');
  });

  test.each([['QQQ'], ['SPY'], ['IWM'], ['ARKK'], ['TLT'], ['GLD'], ['SOXX']])(
    'recognises the well-known ETF %s',
    (ticker) => {
      expect(infer({ prompt: `golden cross on ${ticker}` })).toBe(ticker);
    },
  );

  test('a known ETF wins over a stray acronym elsewhere in the prompt', () => {
    expect(infer({ prompt: 'QQQ golden cross using a 50-day SMA' })).toBe('QQQ');
    expect(infer({ prompt: 'RSI signals on the NASDAQ, trade QQQ' })).toBe('QQQ');
  });

  test('an unlisted all-caps symbol falls back to SPY', () => {
    // Only symbols on the known list (or in the strategy itself) are accepted;
    // anything else defers to the SPY default rather than guessing.
    expect(infer({ name: 'NVDA momentum' })).toBe('SPY');
    expect(infer({ prompt: 'pairs trade KO against PEP' })).toBe('SPY');
  });

  test('the name, prompt and description are all searched', () => {
    expect(infer({ name: 'QQQ Cross' })).toBe('QQQ');
    expect(infer({ prompt: 'hold QQQ' })).toBe('QQQ');
    expect(infer({ description: 'tracks QQQ weekly' })).toBe('QQQ');
  });

  test.each([
    ['a 50-day SMA crossover', 'SMA'],
    ['RSI mean reversion', 'RSI'],
    ['MACD signal line crosses', 'MACD'],
    ['rebalance in USD', 'USD'],
    ['maximize CAGR', 'CAGR'],
    ['5 BPS of costs per trade', 'BPS'],
    ['what the FED does next', 'FED'],
    ['BUY or SELL each week', 'BUY'],
  ])('indicator jargon in %p does not become the ticker %s', (prompt, jargon) => {
    const inferred = infer({ prompt });
    expect(inferred).not.toBe(jargon);
    expect(inferred).toBe('SPY');
  });

  test('an all-caps prompt cannot yield a junk symbol', () => {
    // SHOUTED prompts used to surface the first unlisted all-caps word; the
    // known-ticker allowlist closes that edge, so junk words defer to SPY.
    expect(infer({ prompt: 'BUY AND SELL WEEKLY' })).toBe('SPY');
  });

  test('sentence-case prose is not mistaken for a symbol', () => {
    // Lowercasing the haystack first would turn "Inverse Cramer" into INVERSE.
    expect(infer({ name: 'Inverse Cramer', prompt: 'Fade every Cramer call' })).toBe('SPY');
  });

  test('a lowercase ticker is not a ticker — case is the signal', () => {
    expect(infer({ prompt: 'long qqq for ten years' })).toBe('SPY');
  });

  test('a single capital letter is too short to be a symbol', () => {
    expect(infer({ prompt: 'strategy A versus strategy B' })).toBe('SPY');
  });
});

describe('isValidTicker', () => {
  test.each([['SPY'], ['QQQ'], ['BRK-B'], ['BF.B'], ['A1'], ['ABCDEFGHIJ']])(
    'accepts %p',
    (ticker) => {
      expect(isValidTicker(ticker)).toBe(true);
    },
  );

  test.each([['^GSPC'], ['^VIX'], ['^DJI'], ['^IXIC'], ['^RUT']])(
    'accepts the index symbol %p',
    (ticker) => {
      // Yahoo index symbols always lead with a caret; the symbol charset has to
      // admit one in first position or they can never be fetched at all.
      expect(isValidTicker(ticker)).toBe(true);
    },
  );

  test.each([
    [''],
    ['spy'],
    ['ABCDEFGHIJK'], // 11 chars, over the cap
    ['SPY QQQ'],
    ['../etc/passwd'],
    ['SPY/../..'],
    ['-SPY'],
    ['SPY;rm -rf'],
  ])('rejects %p', (ticker) => {
    expect(isValidTicker(ticker)).toBe(false);
  });

  test('widening the charset did not let a separator start a symbol', () => {
    // Only `^` was added to the leading class; `.` and `-` still may not lead.
    expect(isValidTicker('.SPY')).toBe(false);
    expect(isValidTicker('-SPY')).toBe(false);
  });

  test('a lone caret passes the charset but is harmless', () => {
    // Nothing rejects it here — it is simply not a symbol Yahoo resolves, and
    // an explicitly-requested symbol that does not resolve 502s (PROTOCOL §6).
    expect(isValidTicker('^')).toBe(true);
    expect(isValidTicker('^^^^^^^^^^^^')).toBe(false); // still capped at 10
  });
});

describe('benchmarkCurve', () => {
  // The fixtures below carry 2-5 daily bars from 2020-01-01, so the requested
  // period must end within benchmarkCurve's 14-day coverage tolerance of the
  // last bar — a longer period is rejected as not covering the request.
  const period: Period = { start: '2020-01-01', end: '2020-01-05' };
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stub Yahoo's chart endpoint with the shape the fetcher expects. */
  function stubYahoo(body: unknown, ok = true, status = 200): void {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    if (!ok) {
      globalThis.fetch = (async () =>
        new Response('nope', { status })) as unknown as typeof fetch;
    }
  }

  function chartBody(closes: Array<number | null>): unknown {
    const day = 86400;
    const base = Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000);
    return {
      chart: {
        result: [
          {
            timestamp: closes.map((_, i) => base + i * day),
            indicators: { adjclose: [{ adjclose: closes }] },
          },
        ],
        error: null,
      },
    };
  }

  test('scales the price series to the session starting capital', async () => {
    stubYahoo(chartBody([100, 110, 90, 120]));
    const curve = await benchmarkCurve('TESTA', period, 10000);

    expect(curve).toHaveLength(4);
    expect(curve[0].value).toBe(10000); // always starts at the capital
    expect(curve[1].value).toBeCloseTo(11000, 6); // +10% -> +10%
    expect(curve[2].value).toBeCloseTo(9000, 6);
    expect(curve[3].value).toBeCloseTo(12000, 6);
  });

  test('honours a different starting capital', async () => {
    stubYahoo(chartBody([50, 75]));
    const curve = await benchmarkCurve('TESTB', period, 20000);
    expect(curve[0].value).toBe(20000);
    expect(curve[1].value).toBeCloseTo(30000, 6);
  });

  test('returns ISO dates in ascending order', async () => {
    stubYahoo(chartBody([100, 101, 102]));
    const curve = await benchmarkCurve('TESTC', period, 10000);
    const dates = curve.map((p) => p.date);
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect([...dates].sort()).toEqual(dates);
  });

  test('skips null and non-positive closes', async () => {
    stubYahoo(chartBody([100, null, 0, -5, 120]));
    const curve = await benchmarkCurve('TESTD', period, 10000);
    expect(curve).toHaveLength(2);
  });

  test('falls back to unadjusted closes when adjclose is absent', async () => {
    const day = 86400;
    const base = Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000);
    stubYahoo({
      chart: {
        result: [
          {
            timestamp: [base, base + day],
            indicators: { quote: [{ close: [100, 150] }] },
          },
        ],
      },
    });
    const curve = await benchmarkCurve('TESTE', period, 10000);
    expect(curve[1].value).toBeCloseTo(15000, 6);
  });

  test('a caller-visible error when the symbol has no history', async () => {
    stubYahoo(chartBody([100]));
    await expect(benchmarkCurve('TESTF', period, 10000)).rejects.toThrow(/No price history/);
  });

  test('surfaces Yahoo’s own error description', async () => {
    stubYahoo({ chart: { error: { description: 'No data found, symbol may be delisted' } } });
    await expect(benchmarkCurve('TESTG', period, 10000)).rejects.toThrow(/may be delisted/);
  });

  test('a non-OK response is reported with its status', async () => {
    stubYahoo(null, false, 404);
    await expect(benchmarkCurve('TESTH', period, 10000)).rejects.toThrow(/HTTP 404/);
  });

  test('a repeat request is served from cache without re-fetching', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(chartBody([100, 200])), { status: 200 });
    }) as unknown as typeof fetch;

    await benchmarkCurve('TESTI', period, 10000);
    await benchmarkCurve('TESTI', period, 10000);
    expect(calls).toBe(1);
  });

  test('a different period is a different cache key', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(chartBody([100, 200])), { status: 200 });
    }) as unknown as typeof fetch;

    await benchmarkCurve('TESTJ', period, 10000);
    await benchmarkCurve('TESTJ', { start: '2020-01-01', end: '2020-01-04' }, 10000);
    expect(calls).toBe(2);
  });
});
