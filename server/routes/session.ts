// GET    /api/sessions/[id] — one session, or 404
// DELETE /api/sessions/[id] — interrupt any active run, then delete

import { deleteSession, getSession } from '@/lib/server/store';
import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';


export async function GET(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  return Response.json(session);
}

export async function DELETE(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  if (runManager.isActive(params.id)) {
    await runManager.interrupt(params.id);
  }
  await deleteSession(params.id);
  return Response.json({ ok: true });
}
