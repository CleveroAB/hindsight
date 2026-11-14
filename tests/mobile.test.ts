// The phone views' shaping (server/routes/mobile.ts): the chart a finger scrubs,
// with and without its benchmark, and agent summaries as safe Markdown.

import { describe, expect, test } from 'bun:test';
import { agentMarkdown, toChart, toDetail } from '@/server/routes/mobile';
import { makeResult, makeSession, points } from './helpers';

const curve = points(
  ['2020-01-02', 10000],
  ['2020-06-01', 9000],
  ['2021-01-04', 12000],
  ['2021-12-31', 15000],
);
const session = makeSession({
  period: { start: '2020-01-01', end: '2021-12-31' },
  result: makeResult({ equityCurve: curve, finalValue: 15000, returnPct: 50, ranAt: 1234 }),
});
const benchmark = {
  ticker: 'SPY',
  reason: 'SPY is the broad market.',
  curve: points(['2020-01-02', 10000], ['2020-12-31', 11000], ['2021-12-31', 13000]),
};

describe('toChart', () => {
  test('without a comparison: the strategy alone, and why', () => {
    const chart = toChart(session, null, 'Comparison unavailable right now.');
    expect(chart.key).toBe('1234');
    expect(chart.points).toHaveLength(4);
    expect(chart.line).not.toBe('');
    expect(chart.benchLine).toBe('');
    expect(chart.sharedLine).toBe('');
    expect(chart.ticker).toBe('');
    expect(chart.edgeText).toBe('');
    expect(chart.benchError).toBe('Comparison unavailable right now.');
    expect(chart.points[0]).toMatchObject({ date: 'Jan 2, 2020', value: '$10,000.00', change: '+0.0%', up: true, bench: '' });
    expect(chart.points[1]).toMatchObject({ change: '−10.0%', up: false });
    // The low sits at the bottom of the plot, the high at the top.
    expect(chart.points[1].y).toBeGreaterThan(0.9);
    expect(chart.points[3].y).toBeLessThan(0.1);
  });

  test('with a benchmark: forward-filled onto the strategy’s days, on a shared scale', () => {
    const chart = toChart(session, benchmark);
    expect(chart.ticker).toBe('SPY');
    expect(chart.benchReturnText).toBe('+30.0%');
    expect(chart.edgeText).toBe('Beat SPY by 20.0 points');
    expect(chart.benchError).toBe('');
    // 2020-06-01 has no benchmark close of its own: it takes the last one before it.
    expect(chart.points[1]).toMatchObject({ bench: '$10,000.00', benchChange: '+0.0%' });
    expect(chart.points[3]).toMatchObject({ bench: '$13,000.00', benchChange: '+30.0%' });
    // Shared scale: the strategy ends above the benchmark, so nearer the top.
    expect(chart.points[3].sharedY).toBeLessThan(chart.points[3].benchY);
    expect(chart.stats.map((s) => s.label)).toEqual([
      'Total return', 'Annualized', 'Max drawdown', 'SPY buy & hold', 'Starting capital', 'Final value', 'Period',
    ]);
    expect(chart.stats[2].value).toBe('−10.0%');
    expect(chart.stats[6].value).toBe('Jan 1, 2020 – Dec 31, 2021');
  });

  test('a strategy that trails says so', () => {
    const chart = toChart(session, { ...benchmark, curve: points(['2020-01-02', 10000], ['2021-12-31', 17550]) });
    expect(chart.edgeText).toBe('Trailed SPY by 25.5 points');
  });

  test('no result: an empty chart, not an error', () => {
    const chart = toChart(makeSession(), benchmark);
    expect(chart).toMatchObject({ key: '', line: '', benchLine: '', ticker: '', points: [], stats: [] });
  });

  test('the first and last year are always on the axis', () => {
    const ticks = toChart(session, null).ticks;
    expect(ticks[0]).toEqual({ label: '2020', at: 0 });
    expect(ticks[ticks.length - 1]).toEqual({ label: '2021', at: 1 });
  });
});

describe('agentMarkdown', () => {
  test('keeps paragraphs, bullets and bold labels', () => {
    expect(agentMarkdown('It holds SPY.\n\n**Rules**\n\n- Daily signal.\n- Next-open fills.')).toBe(
      'It holds SPY.\n\n**Rules**\n\n- Daily signal.\n- Next-open fills.',
    );
  });

  test('escapes what Markdown would read as syntax', () => {
    expect(agentMarkdown('Uses close_t * 1.5 and [SPY](x) `raw` #1.')).toBe(
      'Uses close\\_t \\* 1.5 and \\[SPY\\](x) \\`raw\\` \\#1.',
    );
  });
});

describe('toDetail', () => {
  test('agent text is Markdown, user text is as typed, and a note names the backtest', () => {
    const detail = toDetail(
      makeSession({
        id: 'no-live-run',
        chat: [
          { id: 'm1', role: 'user', text: 'Try *weekly*', createdAt: 1 },
          {
            id: 'm2', role: 'agent', text: '**Done**', createdAt: 2,
            metadata: { durationMs: 41000, model: null, effort: null, mode: 'mock', backtestId: 'BT-002' },
          },
        ],
      }),
    );
    expect(detail.resultKey).toBe('');
    expect(detail.messages).toEqual([
      { id: 'm1', role: 'user', text: 'Try *weekly*', note: '' },
      { id: 'm2', role: 'agent', text: '**Done**', note: 'BT-002 · 41 seconds' },
    ]);
  });
});
