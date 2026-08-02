// Formatting contract (lib/format.ts). These strings are user-visible copy and
// are reused verbatim by the share page, so the exact glyphs matter — notably
// U+2212 MINUS (not a hyphen) and U+2013 EN DASH.

import { describe, expect, test } from 'bun:test';
import {
  EN_DASH,
  MINUS,
  formatChangeLine,
  formatDatePill,
  formatDuration,
  formatElapsed,
  formatMetaLine,
  formatMoney,
  formatMoneyWhole,
  formatSignedMoney,
  formatSignedPercent,
  formatYearRange,
  yearOf,
} from '@/lib/format';

describe('money', () => {
  test('formatMoney always shows two decimals', () => {
    expect(formatMoney(30642.05)).toBe('$30,642.05');
    expect(formatMoney(10000)).toBe('$10,000.00');
    expect(formatMoney(0)).toBe('$0.00');
  });

  test('formatMoneyWhole drops the cents', () => {
    expect(formatMoneyWhole(10000)).toBe('$10,000');
    expect(formatMoneyWhole(10000.99)).toBe('$10,001');
  });

  test('formatSignedMoney uses U+2212 for negatives, never a hyphen', () => {
    expect(formatSignedMoney(20642.05)).toBe('+$20,642.05');
    expect(formatSignedMoney(-1234)).toBe(`${MINUS}$1,234.00`);
    expect(formatSignedMoney(-1234)).not.toContain('-');
    expect(MINUS).toBe('−');
  });

  test('zero reads as a gain, not a loss', () => {
    expect(formatSignedMoney(0)).toBe('+$0.00');
  });
});

describe('percent', () => {
  test('one decimal, signed', () => {
    expect(formatSignedPercent(206.4)).toBe('+206.4%');
    expect(formatSignedPercent(-23.8)).toBe(`${MINUS}23.8%`);
    expect(formatSignedPercent(0)).toBe('+0.0%');
  });

  test('rounds to one decimal', () => {
    expect(formatSignedPercent(206.44)).toBe('+206.4%');
    expect(formatSignedPercent(206.46)).toBe('+206.5%');
  });
});

describe('formatChangeLine', () => {
  test('pairs the absolute change with the percent', () => {
    expect(formatChangeLine(30642.05, 10000, 206.4)).toBe('+$20,642.05 (+206.4%)');
  });

  test('a loss is negative on both halves', () => {
    expect(formatChangeLine(7620, 10000, -23.8)).toBe(`${MINUS}$2,380.00 (${MINUS}23.8%)`);
  });
});

describe('dates', () => {
  test('formatDatePill renders a plain calendar date with no timezone shift', () => {
    expect(formatDatePill('2016-01-01')).toBe('Jan 1, 2016');
    expect(formatDatePill('2025-12-31')).toBe('Dec 31, 2025');
  });

  test('formatDatePill returns unparseable input unchanged', () => {
    expect(formatDatePill('not-a-date')).toBe('not-a-date');
    expect(formatDatePill('')).toBe('');
  });

  test('yearOf reads the leading year', () => {
    expect(yearOf('2016-01-01')).toBe(2016);
  });

  test('formatYearRange uses an en dash and collapses a single year', () => {
    expect(formatYearRange('2016-01-01', '2025-12-31')).toBe(`2016${EN_DASH}2025`);
    expect(formatYearRange('2020-01-01', '2020-12-31')).toBe('2020');
    expect(EN_DASH).toBe('–');
  });

  test('formatMetaLine is the expanded-view meta line', () => {
    expect(formatMetaLine('2016-01-01', '2025-12-31', 10000)).toBe(
      `2016${EN_DASH}2025 · $10,000 start`,
    );
  });
});

describe('durations', () => {
  test('formatElapsed is m:ss with a zero-padded seconds field', () => {
    expect(formatElapsed(23000)).toBe('0:23');
    expect(formatElapsed(61000)).toBe('1:01');
    expect(formatElapsed(600000)).toBe('10:00');
    expect(formatElapsed(0)).toBe('0:00');
  });

  test('formatElapsed floors rather than rounds, and clamps negatives', () => {
    expect(formatElapsed(23999)).toBe('0:23');
    expect(formatElapsed(-5000)).toBe('0:00');
  });

  test('formatDuration rounds to whole seconds and spells out units', () => {
    expect(formatDuration(41000)).toBe('41 seconds');
    expect(formatDuration(41600)).toBe('42 seconds');
    expect(formatDuration(-1)).toBe('0 seconds');
    expect(formatDuration(161000)).toBe('2 minutes 41 seconds');
    expect(formatDuration(3600000)).toBe('1 hour');
  });
});
