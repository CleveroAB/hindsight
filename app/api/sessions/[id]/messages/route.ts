// POST /api/sessions/[id]/messages — a chat refinement (edits code + re-runs)
//
// Two encodings (PROTOCOL.md §6):
//   application/json      { "text": "…" }
//   multipart/form-data   text=… plus one `image` part per attached file
// Text is required, EXCEPT when at least one image is attached — an image on
// its own is a legitimate request ("make it look like this").

import { NextResponse } from 'next/server';
import type { Attachment, RefineBody } from '@/lib/types';
import { getSession } from '@/lib/server/store';
import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';
import { getAgentHealth } from '@/lib/server/agent/health';
import { UploadError, imagePartsOf, saveAttachments } from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }

  const isMultipart = (request.headers.get('content-type') ?? '').includes('multipart/form-data');

  let text: string;
  let files: File[] = [];
  if (isMultipart) {
    try {
      const form = await request.formData();
      text = String(form.get('text') ?? '').trim();
      files = imagePartsOf(form);
    } catch {
      return NextResponse.json({ error: 'Invalid form body' }, { status: 400 });
    }
  } else {
    let body: RefineBody;
    try {
      body = (await request.json()) as RefineBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    text = (body?.text ?? '').trim();
  }

  if (!text && files.length === 0) {
    return NextResponse.json({ error: 'A message is required' }, { status: 400 });
  }

  const health = await getAgentHealth();
  if (!health.ready) {
    return NextResponse.json({ error: health.reason }, { status: 503 });
  }

  const existing = await getSession(params.id);
  if (!existing) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  // Store attachments only once the session is known to exist — otherwise a
  // bad id would leave files in a workdir nothing owns.
  let attachments: Attachment[] = [];
  if (files.length > 0) {
    try {
      attachments = await saveAttachments(params.id, files);
    } catch (err) {
      if (err instanceof UploadError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Could not save the images.' }, { status: 500 });
    }
  }

  await runManager.startRun(params.id, 'refine', text, attachments);

  const fresh = (await getSession(params.id)) ?? existing;
  return NextResponse.json(fresh);
}
