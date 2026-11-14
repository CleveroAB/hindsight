// PUT /api/sessions/[id]/model — give one strategy its own model, or clear it
// (`{ "model": null }`) so it follows the app-wide setting again. The model
// must be one Codex offers (GET /api/models); it applies from the next
// LLM-backed run (a refinement), never to a run already in flight.

import type { SessionModelBody } from '@/lib/types';
import { isOfferedModel } from '@/lib/server/models';
import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';
import { getSession, saveSession } from '@/lib/server/store';

export async function PUT(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }

  let body: SessionModelBody;
  try {
    body = (await request.json()) as SessionModelBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const model = body?.model ?? null;
  if (model !== null && !(await isOfferedModel(model))) {
    return Response.json({ error: 'That model is not available from Codex on this machine.' }, { status: 400 });
  }

  // A run in flight holds the session and saves it when it ends; a write
  // here would be lost, and its model was fixed when it started anyway.
  if (runManager.isActive(params.id)) {
    return Response.json({ error: 'Wait for the run to finish, then change the model.' }, { status: 409 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  if (model === null) delete session.model;
  else session.model = model;
  return Response.json(await saveSession(session));
}
