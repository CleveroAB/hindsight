// ============================================================================
// MockRunner — an in-process AgentRunner that fakes a believable backtest run
// with no Docker/Codex. It drives a realistic streamed sequence of progress
// events over ~4-7s (shorter for re-runs), then resolves with a StrategyResult
// built by generateMockCurve(). This is the default runner (HINDSIGHT_AGENT=mock)
// and makes the whole app demoable offline.
//
// The backend run manager owns the ~1s status heartbeat (re-broadcasting the
// current word with authoritative elapsed) and stamps ranAt/durationMs, so this
// runner only emits meaningful transitions and may leave those stamps as-is.
// ============================================================================

import type { AgentRunner, RunHandle, RunInput } from '@/lib/agent-runner';
import { STATUS_WORDS } from '@/lib/agent-runner';
import type { ProgressEvent, StatusWord, StrategyResult } from '@/lib/types';
import { formatMoney, formatSignedPercent, formatYearRange } from '@/lib/format';
import { hashSeed } from '@/lib/chart';
import { generateMockCurve, strategyCadence, type MockCurve } from './mockCurve';

// Status words by role (exact glyphs come from the frozen STATUS_WORDS tuple).
const TINKERING: StatusWord = STATUS_WORDS[0]; // 'Tinkering…'
const SKETCHING: StatusWord = STATUS_WORDS[1]; // 'Sketching…'
const CRUNCHING: StatusWord = STATUS_WORDS[3]; // 'Crunching…'
const ALMOST: StatusWord = STATUS_WORDS[4]; // 'Almost done…'

interface Scheduled {
  at: number;
  run: () => void;
}

/** Honest one-line agent summary: cadence + costs modeled + headline return. */
function buildSummary(
  kind: RunInput['kind'],
  cadence: string,
  curve: MockCurve,
  input: RunInput,
): string {
  const { session } = input;
  const range = formatYearRange(session.period.start, session.period.end);
  const pct = formatSignedPercent(curve.returnPct);
  const finalMoney = formatMoney(curve.finalValue);
  const startMoney = formatMoney(session.startingCapital);

  const intro =
    kind === 'refresh'
      ? 'Re-ran on freshly fetched data'
      : kind === 'rerun'
        ? 'Re-ran with the saved code'
        : kind === 'refine'
          ? 'Reworked it per your note'
          : 'Built it end-to-end';

  const shortNote = /\b(short|inverse|fade|put|puts)\b/.test(session.prompt.toLowerCase())
    ? ' Shorts carry a ~1%/yr borrow fee (higher for hard-to-borrow names).'
    : '';

  return (
    `${intro} — ${cadence} rebalance, 5 bps costs and slippage on every trade, ` +
    `next-bar fills so nothing peeks ahead. Over ${range} it returned ${pct}, ` +
    `ending at ${finalMoney} on ${startMoney}.${shortNote} ` +
    `Where the universe implies delisted names I approximated with survivors and flagged it.`
  );
}

export class MockRunner implements AgentRunner {
  readonly kind = 'mock' as const;

  start(input: RunInput): RunHandle {
    const { session, kind, message, onEvent, signal } = input;
    const startTime = Date.now();

    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    let resolveDone!: (r: StrategyResult) => void;
    let rejectDone!: (e: Error) => void;
    const done = new Promise<StrategyResult>((res, rej) => {
      resolveDone = res;
      rejectDone = rej;
    });

    const emit = (e: ProgressEvent): void => {
      if (!settled) onEvent(e);
    };
    const elapsed = (): number => Date.now() - startTime;
    const emitStatus = (label: StatusWord): void =>
      emit({ type: 'status', label, elapsedMs: elapsed() });

    const teardown = (): void => {
      settled = true;
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      if (settled) return;
      teardown();
      rejectDone(new Error('interrupted'));
    };

    // Already aborted before we could begin.
    if (signal.aborted) {
      teardown();
      rejectDone(new Error('interrupted'));
      return { interrupt: async () => {}, done };
    }
    signal.addEventListener('abort', onAbort);

    // The curve is deterministic and cheap — compute it up front so `meta` can
    // name the strategy early. Refine re-seeds by appending the change request.
    const curvePrompt =
      kind === 'refine' && message ? `${session.prompt}\n${message}` : session.prompt;
    const curve = generateMockCurve({
      prompt: curvePrompt,
      period: session.period,
      startingCapital: session.startingCapital,
    });
    const cadence = strategyCadence(session.prompt);

    const full = kind === 'initial' || kind === 'refine';
    const name = full ? curve.name : session.name || curve.name;
    const description = full ? curve.description : session.description || curve.description;
    const range = formatYearRange(session.period.start, session.period.end);

    const strategyLabel = kind === 'refine' ? 'Strategy updated' : 'Strategy written';
    const dataLabel =
      kind === 'refresh'
        ? `Prices re-fetched, ${range}`
        : kind === 'rerun'
          ? `Prices loaded, ${range}`
          : `Prices fetched, ${range}`;

    const resolveResult = (): void => {
      const result: StrategyResult = {
        equityCurve: curve.equityCurve,
        benchmark: null,
        finalValue: curve.finalValue,
        startingCapital: session.startingCapital,
        returnPct: curve.returnPct,
        code: curve.code,
        // The run manager re-stamps these; set real values anyway.
        ranAt: Date.now(),
        durationMs: elapsed(),
      };
      teardown();
      resolveDone(result);
    };

    // A little deterministic jitter so timings don't feel metronomic.
    const jitter = hashSeed(session.id + kind) % 300;

    // Build the timeline. Full runs write a strategy first; pure re-runs skip
    // straight to data + backtest (no LLM step).
    const timeline: Scheduled[] = full
      ? [
          { at: 0, run: () => emitStatus(TINKERING) },
          { at: 350, run: () => emit({ type: 'meta', name, description }) },
          {
            at: 950,
            run: () => emit({ type: 'step', id: 'strategy', label: strategyLabel, state: 'done' }),
          },
          { at: 1250, run: () => emitStatus(SKETCHING) },
          {
            at: 2300 + jitter,
            run: () => emit({ type: 'step', id: 'data', label: dataLabel, state: 'done' }),
          },
          { at: 2700 + jitter, run: () => emitStatus(CRUNCHING) },
          {
            at: 3100 + jitter,
            run: () =>
              emit({ type: 'step', id: 'backtest', label: 'Running the backtest', state: 'active' }),
          },
          {
            at: 4600 + jitter,
            run: () =>
              emit({ type: 'step', id: 'backtest', label: 'Backtest complete', state: 'done' }),
          },
          { at: 4900 + jitter, run: () => emitStatus(ALMOST) },
          {
            at: 5500 + jitter,
            run: () =>
              emit({ type: 'message', role: 'agent', text: buildSummary(kind, cadence, curve, input) }),
          },
          { at: 6100 + jitter, run: resolveResult },
        ]
      : [
          { at: 0, run: () => emitStatus(SKETCHING) },
          { at: 300, run: () => emit({ type: 'meta', name, description }) },
          {
            at: 400 + jitter,
            run: () => emit({ type: 'step', id: 'data', label: dataLabel, state: 'done' }),
          },
          { at: 800 + jitter, run: () => emitStatus(CRUNCHING) },
          {
            at: 1100 + jitter,
            run: () =>
              emit({ type: 'step', id: 'backtest', label: 'Running the backtest', state: 'active' }),
          },
          {
            at: 2300 + jitter,
            run: () =>
              emit({ type: 'step', id: 'backtest', label: 'Backtest complete', state: 'done' }),
          },
          { at: 2600 + jitter, run: () => emitStatus(ALMOST) },
          {
            at: 3100 + jitter,
            run: () =>
              emit({ type: 'message', role: 'agent', text: buildSummary(kind, cadence, curve, input) }),
          },
          { at: 3500 + jitter, run: resolveResult },
        ];

    for (const { at, run } of timeline) {
      timers.push(
        setTimeout(() => {
          if (!settled) run();
        }, at),
      );
    }

    return {
      interrupt: async () => {
        onAbort();
      },
      done,
    };
  }
}
