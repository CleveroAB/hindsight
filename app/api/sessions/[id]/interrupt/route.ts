// POST /api/sessions/[id]/interrupt — hard-stop the active run for a session

import { NextResponse } from 'next/server';
import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  await runManager.interrupt(params.id);
  return NextResponse.json({ ok: true });
}
