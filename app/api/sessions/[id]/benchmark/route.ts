// GET /api/sessions/[id]/benchmark — buy-and-hold curve for a comparable equity
// over the session's period (the Compare toggle on the chart). Read-only: it
// starts no run and never touches the session file.
//
// `?backtestId=BT-###` selects an immutable response version.
// `?ticker=XXX` explicitly overrides that version's validated recommendation.

import { NextResponse } from 'next/server';
import type { BenchmarkResponse } from '@/lib/types';
import { findBacktest, latestBacktest } from '@/lib/backtests';
import { getSession } from '@/lib/server/store';
import { isValidBacktestId, isValidSessionId } from '@/lib/server/paths';
import {
  DEFAULT_BENCHMARK,
  benchmarkCurve,
  isValidTicker,
  selectBenchmark,
} from '@/lib/server/benchmark';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;
  const requestedBacktestId = searchParams.get('backtestId')?.trim().toUpperCase();
  if (requestedBacktestId && !isValidBacktestId(requestedBacktestId)) {
    return NextResponse.json({ error: 'Invalid backtest id' }, { status: 400 });
  }
  const version = requestedBacktestId
    ? findBacktest(session, requestedBacktestId)
    : undefined;
  if (requestedBacktestId && !version) {
    return NextResponse.json({ error: `Backtest ${requestedBacktestId} not found` }, { status: 404 });
  }

  const targetSession = version
    ? {
        ...session,
        name: version.name,
        description: version.description,
        period: version.period,
        startingCapital: version.startingCapital,
        result: version.result,
      }
    : session;

  const requested = searchParams.get('ticker')?.trim().toUpperCase();
  if (requested && !isValidTicker(requested)) {
    return NextResponse.json({ error: 'Invalid ticker' }, { status: 400 });
  }
  const selected = requested
    ? {
        ticker: requested,
        reason: `${requested} was explicitly selected for this comparison.`,
        source: 'override' as const,
      }
    : selectBenchmark(targetSession);
  let { ticker, reason, source } = selected;

  const startingCapital = targetSession.result?.startingCapital ?? targetSession.startingCapital;
  let curve;
  try {
    curve = await benchmarkCurve(ticker, targetSession.period, startingCapital);
  } catch (err) {
    // Recommendations are revalidated against live adjusted-price coverage.
    // An unavailable inferred/agent choice falls back to the broad market;
    // an explicit caller override fails loudly.
    if (requested || ticker === DEFAULT_BENCHMARK) {
      const message = err instanceof Error ? err.message : `Couldn't load ${ticker}.`;
      // Upstream data problem, not a client mistake.
      return NextResponse.json({ error: message }, { status: 502 });
    }
    try {
      const rejectedTicker = ticker;
      ticker = DEFAULT_BENCHMARK;
      reason = `${reason} ${rejectedTicker} lacked complete price coverage, so SPY is used as the validated fallback.`;
      source = 'fallback';
      curve = await benchmarkCurve(ticker, targetSession.period, startingCapital);
    } catch (fallbackErr) {
      const message =
        fallbackErr instanceof Error ? fallbackErr.message : `Couldn't load ${ticker}.`;
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const finalValue = curve[curve.length - 1].value;
  const body: BenchmarkResponse = {
    ticker,
    reason,
    source,
    backtestId: version?.id ?? latestBacktest(session)?.id ?? null,
    curve,
    finalValue,
    returnPct: startingCapital !== 0 ? (finalValue / startingCapital - 1) * 100 : 0,
  };
  return NextResponse.json(body);
}
