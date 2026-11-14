// POST /api/ideas — one turn of a brainstorm: shaping an idea into a strategy
// before anything is backtested (lib/server/ideas). The client sends the whole
// conversation, ending with the person's message; the answer is what the
// assistant says and its current draft of the strategy. Starts no run and
// writes nothing.

import type { IdeaMessage, IdeasBody } from '@/lib/types';
import { getAgentHealth } from '@/lib/server/agent/health';
import { MAX_IDEA_CHARS, MAX_IDEA_MESSAGES, brainstorm } from '@/lib/server/ideas';
import { isOfferedModel } from '@/lib/server/models';
import { getSettings } from '@/lib/server/settings';

export async function POST(request: Request) {
  let body: IdeasBody;
  try {
    body = (await request.json()) as IdeasBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const raw = Array.isArray(body?.messages) ? body.messages : [];
  const messages: IdeaMessage[] = [];
  for (const m of raw) {
    const role = (m as IdeaMessage)?.role;
    const text = typeof (m as IdeaMessage)?.text === 'string' ? (m as IdeaMessage).text.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !text) {
      return Response.json({ error: 'Each message needs a role and text' }, { status: 400 });
    }
    messages.push({ role, text: text.slice(0, MAX_IDEA_CHARS) });
  }
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return Response.json({ error: 'A message is required' }, { status: 400 });
  }
  if (messages.length > MAX_IDEA_MESSAGES) {
    return Response.json({ error: 'This conversation is long enough: use the strategy so far, or start over.' }, { status: 400 });
  }

  const requested = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
  if (requested !== null && !(await isOfferedModel(requested))) {
    return Response.json({ error: 'That model is not available on this machine.' }, { status: 400 });
  }
  const model = requested ?? (await getSettings()).model;

  const health = await getAgentHealth(model);
  if (!health.ready) {
    return Response.json({ error: health.reason }, { status: 503 });
  }

  try {
    return Response.json(await brainstorm(messages, model));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The model could not answer. Try again.';
    return Response.json({ error: message }, { status: 502 });
  }
}
