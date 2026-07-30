// ============================================================================
// result.json → StrategyResult (PROTOCOL.md §4).
//
// The agent writes this file; the runner is responsible for making it safe to
// render. The important guarantees are that the CURVE wins over the agent's own
// stated figures when they disagree, that the curve is sorted and cleaned, and
// that a result with no usable curve fails loudly instead of rendering an empty
// chart.
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeResultJson } from '@/lib/server/agent/codexRunner';
import { makeSession } from './helpers';

const session = makeSession({ startingCapital: 10000 });
const NO_WORKDIR = '/nonexistent-workdir';

/** The documented happy-path payload from PROTOCOL §4. */
function rawResult(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Inverse Cramer',
    description: 'Fade every Cramer call',
    startingCapital: 10000,
    finalValue: 30642.05,
    returnPct: 206.4,
    equityCurve: [
      ['2016-01-04', 10000.0],
      ['2016-01-05', 10021.3],
      ['2025-12-31', 30642.05],
    ],
    benchmark: null,
    period: { start: '2016-01-01', end: '2025-12-31' },
    ...patch,
  };
}

function normalize(patch: Record<string, unknown> = {}, workDir = NO_WORKDIR) {
  return normalizeResultJson(rawResult(patch), session, Date.now() - 41_000, workDir);
}

describe('the documented payload', () => {
  test('normalizes to a canonical StrategyResult', () => {
    const result = normalize();

    expect(result.equityCurve).toHaveLength(3);
    expect(result.equityCurve[0]).toEqual({ date: '2016-01-04', value: 10000 });
    expect(result.startingCapital).toBe(10000);
    expect(result.finalValue).toBe(30642.05);
    expect(result.returnPct).toBe(206.4);
    expect(result.benchmark).toBeNull();
    expect(result.period).toEqual({ start: '2016-01-01', end: '2025-12-31' });
  });

  test('stamps ranAt and durationMs', () => {
    const before = Date.now();
    const result = normalize();
    expect(result.ranAt).toBeGreaterThanOrEqual(before);
    expect(result.durationMs).toBeGreaterThanOrEqual(41_000);
  });
});

describe('equityCurve shapes', () => {
  test('accepts the compact [date, value] tuple form', () => {
    const result = normalize({ equityCurve: [['2020-01-01', 100], ['2020-01-02', 200]] });
    expect(result.equityCurve).toEqual([
      { date: '2020-01-01', value: 100 },
      { date: '2020-01-02', value: 200 },
    ]);
  });

  test('also accepts the expanded {date, value} form', () => {
    const result = normalize({
      equityCurve: [
        { date: '2020-01-01', value: 100 },
        { date: '2020-01-02', value: 200 },
      ],
    });
    expect(result.equityCurve).toHaveLength(2);
  });

  test('sorts ascending by date regardless of the order written', () => {
    const result = normalize({
      equityCurve: [['2020-03-01', 300], ['2020-01-01', 100], ['2020-02-01', 200]],
    });
    expect(result.equityCurve.map((p) => p.date)).toEqual([
      '2020-01-01',
      '2020-02-01',
      '2020-03-01',
    ]);
  });

  test('drops entries that are not finite points', () => {
    const result = normalize({
      equityCurve: [
        ['2020-01-01', 100],
        ['2020-01-02', 'not a number'], // Number() -> NaN
        ['', 500], // no date
        [
          '2020-01-03',
        ], // too short to be a pair
        ['2020-01-04', 400],
      ],
    });
    expect(result.equityCurve).toEqual([
      { date: '2020-01-01', value: 100 },
      { date: '2020-01-04', value: 400 },
    ]);
  });

  test('a gap in the data is dropped, NOT charted as a crash to $0', () => {
    // Number(null) is 0, which is finite — so a naive coercion would keep the
    // point and draw a plunge to zero that never happened.
    const result = normalize({
      equityCurve: [['2020-01-01', 100], ['2020-01-02', null], ['2020-01-03', 400]],
    });
    expect(result.equityCurve).toEqual([
      { date: '2020-01-01', value: 100 },
      { date: '2020-01-03', value: 400 },
    ]);
  });

  test.each([
    [null, 'null'],
    [undefined, 'undefined'],
    ['', 'an empty string'],
    ['   ', 'whitespace'],
    [true, 'a boolean'],
    [{}, 'an object'],
    [[], 'an empty array'],
  ])('a value of %p (%s) is treated as missing, not as zero', (value) => {
    const result = normalize({
      equityCurve: [['2020-01-01', 100], ['2020-01-02', value], ['2020-01-03', 400]],
    });
    expect(result.equityCurve.map((p) => p.value)).toEqual([100, 400]);
  });

  test('a numeric string is still accepted', () => {
    const result = normalize({
      equityCurve: [['2020-01-01', '100'], ['2020-01-02', '400.50']],
    });
    expect(result.equityCurve.map((p) => p.value)).toEqual([100, 400.5]);
  });

  test('the expanded object form gets the same treatment', () => {
    const result = normalize({
      equityCurve: [
        { date: '2020-01-01', value: 100 },
        { date: '2020-01-02', value: null },
        { date: '2020-01-03', value: 400 },
      ],
    });
    expect(result.equityCurve.map((p) => p.date)).toEqual(['2020-01-01', '2020-01-03']);
  });

  test.each([
    [[]],
    [null],
    [undefined],
    ['not an array'],
    [[['2020-01-01', 'nope']]],
  ])('throws when the curve is unusable: %p', (equityCurve) => {
    // Better a clear failure surfaced as a chat message than an empty chart.
    expect(() => normalize({ equityCurve })).toThrow(/no usable equityCurve/);
  });
});

describe('the curve outranks the agent’s stated figures', () => {
  test('an inconsistent finalValue is replaced by the curve’s last point', () => {
    const result = normalize({ finalValue: 999999 });
    expect(result.finalValue).toBe(30642.05);
  });

  test('a finalValue within half a dollar is kept as written', () => {
    const result = normalize({ finalValue: 30642.3 });
    expect(result.finalValue).toBe(30642.3);
  });

  test('a missing finalValue comes from the curve', () => {
    const result = normalize({ finalValue: undefined });
    expect(result.finalValue).toBe(30642.05);
  });

  test('an inconsistent returnPct is recomputed from the curve', () => {
    const result = normalize({ returnPct: 5000 });
    expect(result.returnPct).toBe(206.4);
  });

  test('a returnPct within tolerance is kept', () => {
    const result = normalize({ returnPct: 206.5 });
    expect(result.returnPct).toBe(206.5);
  });

  test('a missing returnPct is computed', () => {
    const result = normalize({ returnPct: undefined });
    expect(result.returnPct).toBe(206.4);
  });

  test('a loss is reported as a negative return', () => {
    const result = normalize({
      equityCurve: [['2020-01-01', 10000], ['2020-12-31', 7620]],
      finalValue: undefined,
      returnPct: undefined,
    });
    expect(result.finalValue).toBe(7620);
    expect(result.returnPct).toBe(-23.8);
  });

  test('finalValue is rounded to cents and returnPct to one decimal', () => {
    const result = normalize({
      equityCurve: [['2020-01-01', 10000], ['2020-12-31', 12345.6789]],
      finalValue: undefined,
      returnPct: undefined,
    });
    expect(result.finalValue).toBe(12345.68);
    expect(result.returnPct).toBe(23.5);
  });
});

describe('startingCapital', () => {
  test('uses the value in result.json when it is finite', () => {
    expect(normalize({ startingCapital: 50000 }).startingCapital).toBe(50000);
  });

  test.each([[undefined], ['10000'], [Number.NaN]])(
    'falls back to the session when result.json says %p',
    (startingCapital) => {
      expect(normalize({ startingCapital }).startingCapital).toBe(10000);
    },
  );

  test('a zero starting capital yields 0% rather than Infinity', () => {
    const result = normalize({ startingCapital: 0, returnPct: undefined });
    expect(result.returnPct).toBe(0);
    expect(Number.isFinite(result.returnPct)).toBe(true);
  });
});

describe('benchmark', () => {
  test('null when the agent wrote null', () => {
    expect(normalize({ benchmark: null }).benchmark).toBeNull();
  });

  test('null when the agent wrote an empty array', () => {
    expect(normalize({ benchmark: [] }).benchmark).toBeNull();
  });

  test('parsed with the same rules as the main curve', () => {
    const result = normalize({
      benchmark: [['2020-02-01', 200], ['2020-01-01', 100]],
    });
    expect(result.benchmark).toEqual([
      { date: '2020-01-01', value: 100 },
      { date: '2020-02-01', value: 200 },
    ]);
  });
});

describe('code', () => {
  test('prefers the code embedded in result.json', () => {
    expect(normalize({ code: 'print("hi")' }).code).toBe('print("hi")');
  });

  test('falls back to reading strategy.py from the workdir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hindsight-code-'));
    try {
      await writeFile(path.join(dir, 'strategy.py'), '# the real strategy\n', 'utf8');
      expect(normalize({ code: undefined }, dir).code).toBe('# the real strategy\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('stays undefined when there is neither', () => {
    expect(normalize({ code: undefined }).code).toBeUndefined();
  });

  test('a non-string code field is ignored, not coerced', () => {
    expect(normalize({ code: 12345 }).code).toBeUndefined();
  });
});

describe('period passthrough', () => {
  test('carried through when both sides are strings', () => {
    const result = normalize({ period: { start: '2010-01-01', end: '2020-12-31' } });
    expect(result.period).toEqual({ start: '2010-01-01', end: '2020-12-31' });
  });

  test.each([
    [undefined],
    [{ start: '2010-01-01' }],
    [{ start: 2010, end: 2020 }],
    [null],
  ])('omitted when the period is %p', (period) => {
    expect(normalize({ period }).period).toBeUndefined();
  });
});
