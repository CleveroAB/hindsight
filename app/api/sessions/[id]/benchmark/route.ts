// GET /api/sessions/[id]/benchmark — buy-and-hold curve for a comparable equity
// over the session's period (the Compare toggle on the chart). Read-only: it
// starts no run and never touches the session file.
//
// `?ticker=XXX` overrides the symbol inferred from the strategy.

import { NextResponse } from 'next/server';
import type { BenchmarkResponse } from '@/lib/types';
import { getSession } from '@/lib/server/store';
import { isValidSessionId } from '@/lib/server/paths';
import {
  DEFAULT_BENCHMARK,
  benchmarkCurve,
  inferBenchmarkTicker,
  isValidTicker,
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

  const requested = new URL(request.url).searchParams.get('ticker')?.trim().toUpperCase();
  if (requested && !isValidTicker(requested)) {
    return NextResponse.json({ error: 'Invalid ticker' }, { status: 400 });
  }
  let ticker = requested || inferBenchmarkTicker(session);

  const startingCapital = session.result?.startingCapital ?? session.startingCapital;
  let curve;
  try {
    curve = await benchmarkCurve(ticker, session.period, startingCapital);
  } catch (err) {
    // A symbol we inferred from prose can simply not exist ("buy the DIP").
    // Rather than fail the comparison, fall back to the broad market — but a
    // ticker the caller asked for by name fails loudly.
    if (requested || ticker === DEFAULT_BENCHMARK) {
      const message = err instanceof Error ? err.message : `Couldn't load ${ticker}.`;
      // Upstream data problem, not a client mistake.
      return NextResponse.json({ error: message }, { status: 502 });
    }
    try {
      ticker = DEFAULT_BENCHMARK;
      curve = await benchmarkCurve(ticker, session.period, startingCapital);
    } catch (fallbackErr) {
      const message =
        fallbackErr instanceof Error ? fallbackErr.message : `Couldn't load ${ticker}.`;
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const finalValue = curve[curve.length - 1].value;
  const body: BenchmarkResponse = {
    ticker,
    curve,
    finalValue,
    returnPct: startingCapital !== 0 ? (finalValue / startingCapital - 1) * 100 : 0,
  };
  return NextResponse.json(body);
}
