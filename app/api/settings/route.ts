// GET/PUT /api/settings — the model + reasoning effort used for LLM-backed
// runs. PUT takes a partial body; unknown values are refused with 400 so a
// bad model name never reaches `codex exec` inside the container.

import { NextResponse } from 'next/server';
import { CODEX_EFFORTS, CODEX_MODELS, type UpdateSettingsBody } from '@/lib/types';
import { getSettings, updateSettings } from '@/lib/server/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400 });
  }

  const j = body as { model?: unknown; effort?: unknown };
  const patch: UpdateSettingsBody = {};
  if (j.model !== undefined) {
    if (!CODEX_MODELS.includes(j.model as (typeof CODEX_MODELS)[number])) {
      return NextResponse.json(
        { error: `model must be one of: ${CODEX_MODELS.join(', ')}` },
        { status: 400 },
      );
    }
    patch.model = j.model as string;
  }
  if (j.effort !== undefined) {
    if (!CODEX_EFFORTS.includes(j.effort as (typeof CODEX_EFFORTS)[number])) {
      return NextResponse.json(
        { error: `effort must be one of: ${CODEX_EFFORTS.join(', ')}` },
        { status: 400 },
      );
    }
    patch.effort = j.effort as (typeof CODEX_EFFORTS)[number];
  }

  return NextResponse.json(await updateSettings(patch));
}
