// POST /api/sessions/[id]/activate/check — "Check now": run one signal check
// for this strategy immediately, on the scheduler's own serial queue and code
// path. Unlike a scheduled tick the resulting message is ALWAYS sent (HOLD
// included) so the button demonstrably works. Responds { ok: true, update };
// `update` is null when no new bar has closed since the last signal.

import { NextResponse } from 'next/server';
import type { SignalCheckResponse } from '@/lib/types';
import { isValidSessionId } from '@/lib/server/paths';
import { getSession } from '@/lib/server/store';
import { runManager } from '@/lib/server/runManager';
import { getSignalScheduler } from '@/lib/server/signals/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// checkNow rejects with human text, not typed errors. Busy/raced conditions
// (check already in flight, run started mid-check, deactivated mid-queue) are
// conflicts; anything else is a real evaluation/delivery failure. The busy
// messages are stable scheduler strings, matched from the start.
const BUSY_ERROR =
  /^(A signal check is already running|Too many signal checks are queued|A backtest run (is in flight|started during the check)|This strategy is not activated)/;

export async function POST(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!session.activation) {
    return NextResponse.json({ error: 'This strategy is not activated.' }, { status: 409 });
  }
  if (runManager.isActive(params.id) || session.status === 'running') {
    return NextResponse.json(
      { error: 'A backtest run is in flight — try again when it finishes.' },
      { status: 409 },
    );
  }

  try {
    const update = await getSignalScheduler().checkNow(params.id);
    const response: SignalCheckResponse = { ok: true, update };
    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The signal check failed.';
    return NextResponse.json({ error: message }, { status: BUSY_ERROR.test(message) ? 409 : 500 });
  }
}
