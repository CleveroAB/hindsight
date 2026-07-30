// Chart math (lib/chart.ts). Shared by the live React chart, the sparkline and
// the server-rendered share page, so a regression here shows up in three places
// at once. The PRNG is also the seed source for deterministic mock curves.

import { describe, expect, test } from 'bun:test';
import {
  HERO,
  SPARK,
  alignToDates,
  boundsOf,
  downsample,
  equityAreaPath,
  equityLinePath,
  hashSeed,
  normalize,
  normalizeWith,
  pointsToPath,
  rng,
  seededWalk,
  sparklinePath,
} from '@/lib/chart';

describe('rng', () => {
  test('is deterministic for a seed', () => {
    const a = rng(42);
    const b = rng(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  test('different seeds diverge', () => {
    expect(rng(1)()).not.toBe(rng(2)());
  });

  test('stays within [0,1)', () => {
    const r = rng(7);
    for (let i = 0; i < 500; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hashSeed', () => {
  test('is stable for the same string', () => {
    expect(hashSeed('Inverse Cramer')).toBe(hashSeed('Inverse Cramer'));
  });

  test('separates different strings', () => {
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });

  test('returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'x', 'a much longer strategy prompt with spaces']) {
      const h = hashSeed(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('seededWalk', () => {
  test('returns `len` points normalized to [0,1]', () => {
    const pts = seededWalk(hashSeed('seed'), 100, 1, 1.6);
    expect(pts).toHaveLength(100);
    expect(Math.min(...pts)).toBeCloseTo(0, 10);
    expect(Math.max(...pts)).toBeCloseTo(1, 10);
  });

  test('is deterministic', () => {
    expect(seededWalk(5, 50, 1, 2)).toEqual(seededWalk(5, 50, 1, 2));
  });
});

describe('normalize / boundsOf / normalizeWith', () => {
  test('maps min to 0 and max to 1', () => {
    expect(normalize([10, 20, 30])).toEqual([0, 0.5, 1]);
  });

  test('a flat series collapses to zeros rather than dividing by zero', () => {
    expect(normalize([5, 5, 5])).toEqual([0, 0, 0]);
  });

  test('an empty series normalizes to empty', () => {
    expect(normalize([])).toEqual([]);
  });

  test('boundsOf spans every series given', () => {
    expect(boundsOf([1, 2], [0, 9])).toEqual({ min: 0, max: 9 });
  });

  test('boundsOf of nothing is a safe unit range', () => {
    expect(boundsOf()).toEqual({ min: 0, max: 1 });
    expect(boundsOf([])).toEqual({ min: 0, max: 1 });
  });

  test('shared bounds keep two series comparable', () => {
    // The whole point of the Compare toggle: the higher curve must draw higher.
    const strategy = [100, 200];
    const benchmark = [50, 150];
    const bounds = boundsOf(strategy, benchmark);
    const a = normalizeWith(strategy, bounds);
    const b = normalizeWith(benchmark, bounds);
    expect(a[0]).toBeGreaterThan(b[0]);
    expect(a[1]).toBeGreaterThan(b[1]);
  });
});

describe('alignToDates', () => {
  test('forward-fills each date from the most recent point at or before it', () => {
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03'];
    const pts = [
      { date: '2020-01-01', value: 10 },
      { date: '2020-01-03', value: 30 },
    ];
    expect(alignToDates(dates, pts)).toEqual([10, 10, 30]);
  });

  test('dates before the first point carry that first value', () => {
    const pts = [{ date: '2020-06-01', value: 42 }];
    expect(alignToDates(['2020-01-01', '2020-06-01'], pts)).toEqual([42, 42]);
  });

  test('no points means no output', () => {
    expect(alignToDates(['2020-01-01'], [])).toEqual([]);
  });

  test('output length always matches the date axis', () => {
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04'];
    const pts = [{ date: '2020-01-02', value: 1 }];
    expect(alignToDates(dates, pts)).toHaveLength(dates.length);
  });
});

describe('pointsToPath', () => {
  test('an empty series is a degenerate but valid path', () => {
    expect(pointsToPath([], 800, 300, 8)).toBe('M0,0');
  });

  test('a single point draws a flat line across the full width', () => {
    // pad 8, h 300: a normalized 0 sits at y = 300 - 8 = 292.
    expect(pointsToPath([0], 800, 300, 8)).toBe('M0,292.0 L800,292.0');
  });

  test('spans the full width and respects the padding', () => {
    // 0 -> bottom (h - pad), 1 -> top (pad).
    expect(pointsToPath([0, 1], 800, 300, 8)).toBe('M0.0,292.0 L800.0,8.0');
  });

  test('starts with a moveto and continues with linetos', () => {
    const path = pointsToPath([0, 0.5, 1], 800, 300, 8);
    expect(path.startsWith('M')).toBe(true);
    expect(path.split(' ').filter((c) => c.startsWith('L'))).toHaveLength(2);
  });

  test('scale compresses vertically without moving the baseline', () => {
    const full = pointsToPath([1], 800, 300, 8);
    const half = pointsToPath([1], 800, 300, 8, 0.5);
    expect(full).toBe('M0,8.0 L800,8.0');
    expect(half).toBe('M0,150.0 L800,150.0');
  });
});

describe('equity paths', () => {
  test('the line path uses the hero viewBox', () => {
    expect(equityLinePath([10000, 20000])).toBe('M0.0,292.0 L800.0,8.0');
  });

  test('the area path closes the line down to the baseline', () => {
    const values = [10000, 12000, 11000];
    const line = equityLinePath(values);
    const area = equityAreaPath(values);
    expect(area.startsWith(line)).toBe(true);
    expect(area).toBe(`${line} L${HERO.w},${HERO.h} L0,${HERO.h} Z`);
    expect(area.endsWith('Z')).toBe(true);
  });

  test('shared bounds flow through to the drawn path', () => {
    const values = [100, 200];
    const own = equityLinePath(values);
    const shared = equityLinePath(values, { min: 0, max: 400 });
    expect(own).not.toBe(shared);
  });

  test('the sparkline uses its own smaller viewBox', () => {
    const path = sparklinePath([1, 2, 3]);
    const xs = path.split(' ').map((c) => Number.parseFloat(c.slice(1).split(',')[0]));
    expect(Math.max(...xs)).toBe(SPARK.w);
  });
});

describe('downsample', () => {
  test('leaves a short series alone but returns a copy', () => {
    const input = [1, 2, 3];
    const out = downsample(input, 90);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test('hits the target length and keeps both endpoints', () => {
    const input = Array.from({ length: 2500 }, (_, i) => i);
    const out = downsample(input, 90);
    expect(out).toHaveLength(90);
    expect(out[0]).toBe(0);
    expect(out[89]).toBe(2499);
  });

  test('picks evenly spaced samples', () => {
    expect(downsample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([1, 6, 10]);
  });

  test('a long curve still sparklines without blowing up', () => {
    const values = Array.from({ length: 4000 }, (_, i) => 10000 + i);
    expect(sparklinePath(values).split(' ')).toHaveLength(90);
  });
});
