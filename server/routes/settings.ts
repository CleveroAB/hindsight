// GET/PUT /api/settings — the model + reasoning effort used for LLM-backed
// runs. PUT takes a partial body; unknown values are refused with 400 so a
// bad model name never reaches `codex exec` inside the container. A model is
// known when Codex offers it (GET /api/models).

import { CODEX_EFFORTS, type UpdateSettingsBody } from '@/lib/types';
import { listModels } from '@/lib/server/models';
import { getSettings, updateSettings } from '@/lib/server/settings';


export async function GET() {
  return Response.json(await getSettings());
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const j = body as { model?: unknown; effort?: unknown };
  const patch: UpdateSettingsBody = {};
  if (j.model !== undefined) {
    const offered = (await listModels()).models.map((m) => m.id);
    if (typeof j.model !== 'string' || !offered.includes(j.model)) {
      return Response.json(
        { error: `model must be one of: ${offered.join(', ')}` },
        { status: 400 },
      );
    }
    patch.model = j.model;
  }
  if (j.effort !== undefined) {
    if (!CODEX_EFFORTS.includes(j.effort as (typeof CODEX_EFFORTS)[number])) {
      return Response.json(
        { error: `effort must be one of: ${CODEX_EFFORTS.join(', ')}` },
        { status: 400 },
      );
    }
    patch.effort = j.effort as (typeof CODEX_EFFORTS)[number];
  }

  return Response.json(await updateSettings(patch));
}
