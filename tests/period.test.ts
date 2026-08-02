// Period inference from a prompt (lib/period.ts). This decides the backtest
// window whenever the composer sends no explicit dates, so a wrong answer
// silently backtests the wrong decade.

import { describe, expect, test } from 'bun:test';
import { parsePeriodFromPrompt } from '@/lib/period';

describe('explicit year ranges', () => {
  test.each([
    ['2016 to 2025'],
    ['2016-2025'],
    ['2016–2025'], // en dash
    ['from 2016 to 2025'],
    ['between 2016 and 2025'],
    ['fade every Cramer call, 2016 through 2025, weekly rebalance'],
  ])('%p spans both full calendar years', (prompt) => {
    expect(parsePeriodFromPrompt(prompt)).toEqual({
      start: '2016-01-01',
      end: '2025-12-31',
    });
  });

  test('a reversed range is normalized to ascending', () => {
    expect(parsePeriodFromPrompt('2025 back to 2016')).toEqual({
      start: '2016-01-01',
      end: '2025-12-31',
    });
  });

  test('more than two years spans the first and last mentioned', () => {
    expect(parsePeriodFromPrompt('compare 2010, 2015 and 2020')).toEqual({
      start: '2010-01-01',
      end: '2020-12-31',
    });
  });
});

describe('a single year', () => {
  test('becomes that whole year', () => {
    expect(parsePeriodFromPrompt('short the meme stocks in 2020')).toEqual({
      start: '2020-01-01',
      end: '2020-12-31',
    });
  });
});

describe('no usable year', () => {
  test.each([
    [''],
    ['buy and hold the index'],
    ["'16-'25"], // two-digit years are deliberately ignored
    ['a 50/200 SMA golden cross'],
    ['1969 moon landing'], // below the accepted 1970..2099 window
    ['the year 2100'], // above it
  ])('%p yields null', (prompt) => {
    expect(parsePeriodFromPrompt(prompt)).toBeNull();
  });
});

describe('the shared global regex', () => {
  // YEAR_RE is module-level and /g, so it carries lastIndex between calls. The
  // exec loop always runs to exhaustion and a failed exec resets lastIndex to 0,
  // so the explicit reset in parsePeriodFromPrompt is belt-and-braces rather
  // than load-bearing today. These tests pin the property itself, so that an
  // early `break` or a switch to .test()/.match() later cannot silently make
  // repeat calls diverge.
  test('does not leak match state across calls', () => {
    const prompt = 'from 2016 to 2025';
    const first = parsePeriodFromPrompt(prompt);
    const second = parsePeriodFromPrompt(prompt);
    const third = parsePeriodFromPrompt(prompt);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test('interleaved calls with different prompts stay independent', () => {
    expect(parsePeriodFromPrompt('2016 to 2025')).toEqual({
      start: '2016-01-01',
      end: '2025-12-31',
    });
    expect(parsePeriodFromPrompt('in 2020')).toEqual({
      start: '2020-01-01',
      end: '2020-12-31',
    });
    expect(parsePeriodFromPrompt('2016 to 2025')).toEqual({
      start: '2016-01-01',
      end: '2025-12-31',
    });
  });
});
