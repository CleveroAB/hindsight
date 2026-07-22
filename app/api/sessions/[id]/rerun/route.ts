// POST /api/sessions/[id]/rerun — re-run reusing saved code (optionally new dates
// or a fresh data fetch)

import { NextResponse } from 'next/server';
import type { RerunBody } from '@/lib/types';
import { getSession, saveSession } from '@/lib/server/store';
import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  let body: RerunBody;
  try {
    body = (await request.json()) as RerunBody;
  } catch {
    body = {};
  }

  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Apply new dates before the run so params.json reflects them.
  if (body?.period && (body.period.start || body.period.end)) {
    const next = {
      start: body.period.start ?? session.period.start,
      end: body.period.end ?? session.period.end,
    };
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO_DATE.test(next.start) || !ISO_DATE.test(next.end)) {
      return NextResponse.json({ error: 'Dates must be YYYY-MM-DD' }, { status: 400 });
    }
    // ISO dates compare correctly as strings.
    if (next.start > next.end) {
      return NextResponse.json({ error: 'The start date must be before the end date' }, { status: 400 });
    }
    session.period = next;
    await saveSession(session);
  }

  await runManager.startRun(params.id, body?.refreshData ? 'refresh' : 'rerun');

  const fresh = (await getSession(params.id)) ?? session;
  return NextResponse.json(fresh);
}
