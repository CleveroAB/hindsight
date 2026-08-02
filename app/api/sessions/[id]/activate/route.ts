// POST /api/sessions/[id]/activate — start scheduled buy/sell signal checks
// for a finished strategy: derive the check cadence from the strategy itself,
// arm the scheduler, send the confirmation message, and record a system chat
// note. Idempotent-ish: re-activating updates the phone / re-derives the
// cadence and only re-sends the confirmation when the phone actually changed.
// DELETE — stop the checks (activation → null), re-arm the scheduler, and send
// the deactivation message. Deactivating an inactive session is a 200 no-op.
// Both return the full updated Session, and both are 409 while a backtest run
// is live — the run manager heartbeats the session file during a run, and
// session JSON is whole-file last-writer-wins.

import { NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import type { ActivateBody, StrategyActivation } from '@/lib/types';
import { isValidSessionId } from '@/lib/server/paths';
import { appendChat, getSession, saveSession } from '@/lib/server/store';
import { runManager } from '@/lib/server/runManager';
import { deriveCadence, nextCheckTime } from '@/lib/server/signals/cadence';
import {
  composeActivationMessage,
  composeDeactivationMessage,
  composeDestinationChangedMessage,
  normalizePhone,
  sendSignalMessage,
} from '@/lib/server/signals/messenger';
import { getSignalScheduler } from '@/lib/server/signals/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  let body: ActivateBody;
  try {
    body = (await request.json()) as ActivateBody;
  } catch {
    body = {};
  }
  // An explicit phone wins; otherwise the env default. An explicit but
  // malformed number is a 400, never a silent fallback to the env one.
  const supplied = typeof body?.phone === 'string' && body.phone.trim() ? body.phone : null;
  const phone = normalizePhone(supplied ?? process.env.HINDSIGHT_SIGNAL_PHONE);
  if (!phone) {
    return NextResponse.json(
      {
        error: supplied
          ? 'The phone number must be E.164, e.g. +46701234567.'
          : 'No phone number — send { "phone": "+…" } or set HINDSIGHT_SIGNAL_PHONE.',
      },
      { status: 400 },
    );
  }

  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (runManager.isActive(params.id) || session.status === 'running') {
    return NextResponse.json(
      { error: 'A backtest run is in flight — try again when it finishes.' },
      { status: 409 },
    );
  }
  if (!session.result) {
    return NextResponse.json(
      { error: 'This strategy has no successful backtest yet — run it once before activating.' },
      { status: 400 },
    );
  }

  const now = Date.now();
  const existing = session.activation ?? null;
  const { cadence, reason, assetClass } = deriveCadence(session);
  const activation: StrategyActivation = {
    phone,
    activatedAt: existing?.activatedAt ?? now,
    cadence,
    cadenceReason: reason,
    nextCheckAt: nextCheckTime(cadence, assetClass, new Date(now)).getTime(),
    lastCheckAt: existing?.lastCheckAt ?? null,
    lastSignal: existing?.lastSignal ?? null,
    lastError: existing?.lastError ?? null,
  };
  session.activation = activation;
  await saveSession(session);
  getSignalScheduler().poke();

  // Confirmation + system chat note — skipped on a re-activation that changed
  // nothing the user would notice (same phone; at most a re-derived cadence).
  if (existing && existing.phone === phone) {
    return NextResponse.json(session);
  }
  const text = composeActivationMessage(session.name, activation);
  try {
    await sendSignalMessage(phone, text);
  } catch (err) {
    // Still activated: record the delivery failure on the activation itself so
    // the response (and the UI) carry it.
    const message =
      err instanceof Error ? err.message : 'The activation message could not be sent.';
    activation.lastError = message;
    // Re-read before saving: the send can block for up to 15s (osascript),
    // long enough for a run to start — or even finish — and session JSON is
    // whole-file last-writer-wins, so writing the pre-send snapshot back would
    // erase the run's result/backtest version/chat.
    const fresh = await getSession(params.id);
    if (
      fresh?.activation &&
      fresh.activation.phone === phone &&
      !runManager.isActive(params.id) &&
      fresh.status !== 'running'
    ) {
      fresh.activation.lastError = message;
      await saveSession(fresh);
    }
  }
  // A changed destination is a real-world redirect of an out-of-band channel —
  // the number losing the signals must hear about it (best-effort, never fails
  // the request).
  if (existing && existing.phone !== phone) {
    try {
      await sendSignalMessage(existing.phone, composeDestinationChangedMessage(session.name, phone));
    } catch (err) {
      console.error('[hindsight] destination-change notice failed', err);
    }
  }
  const withNote = await appendChat(params.id, {
    id: nanoid(),
    role: 'system',
    text,
    createdAt: Date.now(),
  });
  return NextResponse.json(withNote ?? session);
}

export async function DELETE(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (runManager.isActive(params.id) || session.status === 'running') {
    return NextResponse.json(
      { error: 'A backtest run is in flight — try again when it finishes.' },
      { status: 409 },
    );
  }
  if (!session.activation) {
    return NextResponse.json(session); // already inactive — nothing to do, no message
  }

  const phone = session.activation.phone;
  session.activation = null;
  await saveSession(session);
  getSignalScheduler().poke();

  const text = composeDeactivationMessage(session.name);
  try {
    await sendSignalMessage(phone, text);
  } catch (err) {
    // Best-effort goodbye: the strategy IS deactivated either way.
    console.error('[hindsight] deactivation message failed', err);
  }
  const withNote = await appendChat(params.id, {
    id: nanoid(),
    role: 'system',
    text,
    createdAt: Date.now(),
  });
  return NextResponse.json(withNote ?? session);
}
