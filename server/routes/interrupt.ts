// POST /api/sessions/[id]/interrupt — hard-stop the active run for a session

import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';


export async function POST(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  await runManager.interrupt(params.id);
  return Response.json({ ok: true });
}
