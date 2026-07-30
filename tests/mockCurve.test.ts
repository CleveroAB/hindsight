// The procedural mock backtester (lib/server/agent/mockCurve.ts). It backs the
// default runner, so it is what most people see first. The contract that
// matters: determinism for a given (prompt, period), a curve that starts at the
// starting capital, and a strictly ascending date axis.

import { describe, expect, test } from 'bun:test';
import {
  deriveDescription,
  deriveName,
  generateMockCurve,
  strategyCadence,
} from '@/lib/server/agent/mockCurve';

const period = { start: '2016-01-01', end: '2025-12-31' };
const curve = (prompt: string, overrides: Partial<Parameters<typeof generateMockCurve>[0]> = {}) =>
  generateMockCurve({ prompt, period, startingCapital: 10000, ...overrides });

describe('generateMockCurve', () => {
  test('is deterministic for the same inputs', () => {
    expect(curve('inverse Cramer')).toEqual(curve('inverse Cramer'));
  });

  test('a different prompt gives a different curve', () => {
    expect(curve('inverse Cramer').equityCurve).not.toEqual(curve('buy and hold').equityCurve);
  });

  test('a different period gives a different curve', () => {
    const a = curve('same prompt');
    const b = curve('same prompt', { period: { start: '2010-01-01', end: '2015-12-31' } });
    expect(a.equityCurve).not.toEqual(b.equityCurve);
  });

  test('starts exactly at the starting capital', () => {
    expect(curve('anything').equityCurve[0].value).toBe(10000);
    expect(curve('anything', { startingCapital: 50000 }).equityCurve[0].value).toBe(50000);
  });

  test('dates are strictly ascending', () => {
    const dates = curve('momentum rotation').equityCurve.map((p) => p.date);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] > dates[i - 1]).toBe(true);
    }
  });

  test('every value is a finite positive number', () => {
    for (const point of curve('short the meme stocks').equityCurve) {
      expect(Number.isFinite(point.value)).toBe(true);
      expect(point.value).toBeGreaterThan(0);
      expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('finalValue and returnPct agree with the curve', () => {
    const c = curve('golden cross on SPY');
    expect(c.finalValue).toBe(c.equityCurve[c.equityCurve.length - 1].value);
    expect(c.returnPct).toBeCloseTo(Math.round((c.finalValue / 10000 - 1) * 1000) / 10, 6);
  });

  test('roughly 252 points per year, within the clamp', () => {
    const oneYear = curve('x', { period: { start: '2020-01-01', end: '2020-12-31' } });
    expect(oneYear.equityCurve.length).toBeGreaterThan(200);
    expect(oneYear.equityCurve.length).toBeLessThan(300);
  });

  test.each([
    [{ start: '2020-12-31', end: '2020-01-01' }, 'an inverted period'],
    [{ start: 'garbage', end: 'also garbage' }, 'unparseable dates'],
    [{ start: '2020-01-01', end: '2020-01-01' }, 'a zero-length period'],
  ])('still produces a usable curve for %p (%s)', (p) => {
    const c = curve('x', { period: p });
    expect(c.equityCurve.length).toBeGreaterThanOrEqual(40);
    expect(c.equityCurve[0].value).toBe(10000);
  });

  test.each([[0], [-100], [Number.NaN]])(
    'an unusable starting capital of %p falls back to $10,000',
    (startingCapital) => {
      expect(curve('x', { startingCapital }).equityCurve[0].value).toBe(10000);
    },
  );

  test('the generated code is honest about costs and lookahead', () => {
    // AGENTS.md / PROTOCOL §5 realism rules, mirrored in the displayed snippet.
    const code = curve('anything').code;
    expect(code).toContain('COST_BPS');
    expect(code).toContain('SLIP_BPS');
    expect(code).toContain('BORROW_APR');
    expect(code).toContain('no lookahead');
    expect(code).toContain('result.json');
  });
});

describe('deriveName', () => {
  test.each([
    ['fade every Cramer call', 'Inverse Cramer'],
    ['short Cramer picks', 'Inverse Cramer'],
    ['follow every Cramer call', 'Cramer Calls'],
    ['50/200 golden cross', 'Golden Cross'],
    ['12-month momentum rotation', 'Momentum Rotation'],
    ['mean-reversion on dips', 'Mean Reversion'],
    ['pairs trade KO and PEP', 'Pairs Trade'],
    ['20-day sma crossover', 'Moving-Average Cross'],
    ['60/40 stocks and bonds', '60/40 Portfolio'],
    ['dca into the market', 'Dollar-Cost Average'],
    ['just hold spy', 'S&P Buy & Hold'],
  ])('names %p as %p', (prompt, expected) => {
    expect(deriveName(prompt)).toBe(expected);
  });

  test('a strategy pattern outranks a mere asset mention', () => {
    expect(deriveName('Golden cross on SPY, 50/200 SMA')).toBe('Golden Cross');
  });

  test('falls back to the first meaningful words, dropping stopwords', () => {
    expect(deriveName('rotate into gold')).toBe('Rotate Gold');
  });

  test('drops a trailing word rather than exceed the 24-char cap', () => {
    // 'Rotate Utilities Quarterly' is 26 chars, so the last word is cut whole.
    expect(deriveName('rotate into utilities quarterly')).toBe('Rotate Utilities');
  });

  test('a prompt of nothing but stopwords still gets a name', () => {
    expect(deriveName('the a an of to and')).toBe('Backtest');
    expect(deriveName('')).toBe('Backtest');
  });

  test('never exceeds 24 characters', () => {
    const long = deriveName('extraordinarily verbose supercalifragilistic terminology here');
    expect(long.length).toBeLessThanOrEqual(24);
    expect(long.endsWith(' ')).toBe(false);
  });
});

describe('strategyCadence', () => {
  test.each([
    ['rebalance daily', 'daily'],
    ['trade every day', 'daily'],
    ['monthly rebalance', 'monthly'],
    ['dca into it', 'monthly'],
    ['dollar-cost average in', 'monthly'],
    ['rebalance quarterly', 'quarterly'],
    ['every quarter', 'quarterly'],
    ['weekly rebalance', 'weekly'],
    ['no cadence mentioned at all', 'weekly'],
  ])('%p is %p', (prompt, expected) => {
    expect(strategyCadence(prompt)).toBe(expected);
  });
});

describe('deriveDescription', () => {
  test('appends the cadence when the prompt does not mention one', () => {
    expect(deriveDescription('fade every Cramer call', 'weekly')).toBe(
      'fade every Cramer call, weekly rebalance',
    );
  });

  test('does not append when the prompt already says it', () => {
    expect(deriveDescription('fade Cramer, weekly', 'weekly')).toBe('fade Cramer, weekly');
    expect(deriveDescription('rebalance into gold', 'weekly')).toBe('rebalance into gold');
  });

  test('collapses whitespace', () => {
    expect(deriveDescription('lots   of\n\nspace', 'weekly')).toBe(
      'lots of space, weekly rebalance',
    );
  });

  test('truncates a long prompt on a word boundary with an ellipsis', () => {
    const description = deriveDescription(
      'an extremely long strategy description that just keeps going and going past the limit',
      'weekly',
    );
    expect(description).toContain('…');
    expect(description).not.toContain('  ');
    expect(description.length).toBeLessThan(80);
  });
});
