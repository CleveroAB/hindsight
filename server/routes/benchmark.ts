// GET /api/sessions/[id]/benchmark — buy-and-hold curve for a comparable equity
// over the session's period (the Compare toggle on the chart). Read-only: it
// starts no run and never touches the session file.
//
// `?backtestId=BT-###` selects an immutable response version.
// `?ticker=XXX` explicitly overrides that version's validated recommendation.

import type { BenchmarkResponse } from '@/lib/types';
import { findBacktest, latestBacktest } from '@/lib/backtests';
import { getSession } from '@/lib/server/store';
import { isValidBacktestId, isValidSessionId } from '@/lib/server/paths';
import { benchmarkCurve, isValidTicker, presentedBenchmark } from '@/lib/server/benchmark';


export async function GET(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;
  const requestedBacktestId = searchParams.get('backtestId')?.trim().toUpperCase();
  if (requestedBacktestId && !isValidBacktestId(requestedBacktestId)) {
    return Response.json({ error: 'Invalid backtest id' }, { status: 400 });
  }
  const version = requestedBacktestId
    ? findBacktest(session, requestedBacktestId)
    : undefined;
  if (requestedBacktestId && !version) {
    return Response.json({ error: `Backtest ${requestedBacktestId} not found` }, { status: 404 });
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
    return Response.json({ error: 'Invalid ticker' }, { status: 400 });
  }
  const startingCapital = targetSession.result?.startingCapital ?? targetSession.startingCapital;
  let presented;
  try {
    presented = requested
      ? {
          ticker: requested,
          reason: `${requested} was explicitly selected for this comparison.`,
          source: 'override' as const,
          // An explicit caller override fails loudly instead of falling back.
          curve: await benchmarkCurve(requested, targetSession.period, startingCapital),
        }
      : await presentedBenchmark(targetSession);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Couldn't load the comparison.";
    // Upstream data problem, not a client mistake.
    return Response.json({ error: message }, { status: 502 });
  }
  const { ticker, reason, source, curve } = presented;

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
  return Response.json(body);
}
