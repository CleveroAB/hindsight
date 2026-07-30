// ============================================================================
// The mock AgentRunner, driven end to end (PROTOCOL.md §2 and §3).
//
// This is the only runner that can be exercised without Docker, and it is the
// default one, so it doubles as the executable check that the AgentRunner
// contract holds: events stream in the documented order, `done` resolves with a
// usable StrategyResult, and an abort rejects instead of hanging.
//
// These tests wait on the runner's real timeline (a few seconds each) rather
// than faking timers — the scheduling IS part of what is being checked.
// ============================================================================

import { beforeAll, describe, expect, test } from 'bun:test';
import type { RunKind } from '@/lib/agent-runner';
import { STATUS_WORDS } from '@/lib/agent-runner';
import type { ProgressEvent, StrategyResult } from '@/lib/types';
import { MockRunner } from '@/lib/server/agent/mockRunner';
import { makeSession } from './helpers';

interface Run {
  events: ProgressEvent[];
  result: StrategyResult;
}

/** Drive a full run to completion, collecting everything it emitted. */
async function runToCompletion(kind: RunKind, message?: string): Promise<Run> {
  const events: ProgressEvent[] = [];
  const handle = new MockRunner().start({
    session: makeSession({
      id: 'mock-run',
      prompt: 'fade every Cramer call',
      period: { start: '2016-01-01', end: '2025-12-31' },
    }),
    workDir: '/tmp/unused-by-the-mock',
    kind,
    message,
    onEvent: (e) => events.push(e),
    signal: new AbortController().signal,
  });
  return { events, result: await handle.done };
}

const typesOf = (events: ProgressEvent[]): string[] => events.map((e) => e.type);
const stepsOf = (events: ProgressEvent[]) =>
  events.filter((e): e is Extract<ProgressEvent, { type: 'step' }> => e.type === 'step');

describe('a full initial run', () => {
  // One run, shared by every assertion below — it takes ~6s of real timeline.
  let run: Run;
  beforeAll(async () => {
    run = await runToCompletion('initial');
  }, 20_000);

  test(
    'streams the documented sequence and resolves with a result',
    () => {
      // §3: status first, then the strategy is named as early as possible.
      expect(typesOf(run.events)[0]).toBe('status');
      expect(typesOf(run.events)).toContain('meta');
      expect(typesOf(run.events).indexOf('meta')).toBeLessThan(
        typesOf(run.events).indexOf('step'),
      );

      // The three documented steps, in order.
      expect(stepsOf(run.events).map((s) => s.id)).toEqual([
        'strategy',
        'data',
        'backtest',
        'backtest',
      ]);

      // A step id goes active before it goes done, and the later `done`
      // supersedes the earlier `active` row for the same id.
      const backtest = stepsOf(run.events).filter((s) => s.id === 'backtest');
      expect(backtest.map((s) => s.state)).toEqual(['active', 'done']);

      // It ends by telling the user what it did.
      const messages = run.events.filter((e) => e.type === 'message');
      expect(messages).toHaveLength(1);
    },
  );

  test('only ever emits the five known status words', () => {
    const statuses = run.events.filter((e) => e.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) {
      expect(STATUS_WORDS).toContain((status as { label: string }).label as never);
    }
  });

  test('status elapsedMs only moves forward', () => {
    const elapsed = run.events
      .filter((e) => e.type === 'status')
      .map((e) => (e as { elapsedMs: number }).elapsedMs);
    expect([...elapsed].sort((a, b) => a - b)).toEqual(elapsed);
  });

  test('the agent summary is honest about costs and assumptions', () => {
    const summary = run.events.find((e) => e.type === 'message') as { text: string };
    expect(summary.text).toContain('5 bps');
    expect(summary.text).toContain('next-bar fills');
    expect(summary.text).toMatch(/borrow fee/); // the prompt says "fade"
  });

  test('the result satisfies the StrategyResult contract', () => {
    const { result } = run;
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.startingCapital).toBe(10000);
    expect(result.finalValue).toBe(result.equityCurve[result.equityCurve.length - 1].value);
    expect(result.equityCurve[0].value).toBe(10000);
    expect(result.benchmark).toBeNull();
    expect(typeof result.code).toBe('string');
    expect(result.ranAt).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test('the curve is sorted ascending by date', () => {
    const dates = run.result.equityCurve.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('a re-run skips the strategy step', () => {
  test(
    'no LLM step is reported for kind=rerun',
    async () => {
      const run = await runToCompletion('rerun');

      // PROTOCOL §2: a rerun re-executes saved code with no agent involvement,
      // so "Strategy written" would be a lie.
      const ids = stepsOf(run.events).map((s) => s.id);
      expect(ids).not.toContain('strategy');
      expect(ids).toContain('data');
      expect(ids).toContain('backtest');
      expect(run.result.equityCurve.length).toBeGreaterThan(0);
    },
    20_000,
  );

  test(
    'a refresh run says the prices were re-fetched',
    async () => {
      const run = await runToCompletion('refresh');
      const data = stepsOf(run.events).find((s) => s.id === 'data');
      expect(data?.label).toContain('re-fetched');
    },
    20_000,
  );
});

describe('interruption', () => {
  test('interrupt() rejects the run and stops the event stream', async () => {
    const events: ProgressEvent[] = [];
    const handle = new MockRunner().start({
      session: makeSession({ id: 'interrupt-me' }),
      workDir: '/tmp/unused',
      kind: 'initial',
      onEvent: (e) => events.push(e),
      signal: new AbortController().signal,
    });

    await handle.interrupt();
    await expect(handle.done).rejects.toThrow(/interrupted/);

    const seen = events.length;
    await Bun.sleep(200);
    expect(events.length).toBe(seen); // nothing arrives after the interrupt
  });

  test('aborting the signal rejects the run', async () => {
    const controller = new AbortController();
    const handle = new MockRunner().start({
      session: makeSession({ id: 'abort-me' }),
      workDir: '/tmp/unused',
      kind: 'initial',
      onEvent: () => {},
      signal: controller.signal,
    });

    controller.abort();
    await expect(handle.done).rejects.toThrow(/interrupted/);
  });

  test('a signal already aborted before start never runs', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: ProgressEvent[] = [];

    const handle = new MockRunner().start({
      session: makeSession({ id: 'pre-aborted' }),
      workDir: '/tmp/unused',
      kind: 'initial',
      onEvent: (e) => events.push(e),
      signal: controller.signal,
    });

    await expect(handle.done).rejects.toThrow(/interrupted/);
    expect(events).toHaveLength(0);
  });

  test('interrupt() is idempotent', async () => {
    const handle = new MockRunner().start({
      session: makeSession({ id: 'twice' }),
      workDir: '/tmp/unused',
      kind: 'initial',
      onEvent: () => {},
      signal: new AbortController().signal,
    });

    await handle.interrupt();
    await handle.interrupt();
    await expect(handle.done).rejects.toThrow(/interrupted/);
  });
});

describe('the runner identifies itself', () => {
  test('kind is "mock" so the run manager can branch on it', () => {
    expect(new MockRunner().kind).toBe('mock');
  });
});
