// GET  /api/sessions — list all sessions (newest first)
// POST /api/sessions — create a strategy from a prompt and start run #1

import { NextResponse } from 'next/server';
import type { CreateSessionBody } from '@/lib/types';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  saveSession,
} from '@/lib/server/store';
import { runManager } from '@/lib/server/runManager';
import { getAgentHealth } from '@/lib/server/agent/health';
import {
  UploadError,
  imagePartsOf,
  validateImages,
  writeImages,
  type ValidatedImage,
} from '@/lib/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const isMultipart = (request.headers.get('content-type') ?? '').includes('multipart/form-data');

  let body: CreateSessionBody;
  let files: File[] = [];
  if (isMultipart) {
    try {
      const form = await request.formData();
      const num = (v: FormDataEntryValue | null): number | undefined => {
        const n = Number(v);
        return v != null && v !== '' && Number.isFinite(n) ? n : undefined;
      };
      const start = form.get('start');
      const end = form.get('end');
      body = {
        prompt: String(form.get('prompt') ?? ''),
        period:
          start || end
            ? { start: start ? String(start) : undefined, end: end ? String(end) : undefined }
            : undefined,
        startingCapital: num(form.get('startingCapital')),
      };
      files = imagePartsOf(form);
    } catch {
      return NextResponse.json({ error: 'Invalid form body' }, { status: 400 });
    }
  } else {
    try {
      body = (await request.json()) as CreateSessionBody;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const prompt = (body?.prompt ?? '').trim();
  if (!prompt) {
    // Unlike a chat refinement, a new strategy needs words: an image alone
    // can't say what period to test or what to do with what it shows.
    return NextResponse.json({ error: 'A prompt is required' }, { status: 400 });
  }

  // Any explicitly supplied period sides must be dates; a fully supplied
  // window must also be ordered (missing sides are defaulted by the store).
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const { start, end } = body.period ?? {};
  if ((start && !ISO_DATE.test(start)) || (end && !ISO_DATE.test(end))) {
    return NextResponse.json({ error: 'Dates must be YYYY-MM-DD' }, { status: 400 });
  }
  if (start && end && start > end) {
    return NextResponse.json({ error: 'The start date must be before the end date' }, { status: 400 });
  }

  // Validate images BEFORE creating anything — the names are assigned here, so
  // the session can record them, but nothing is written until it exists. A
  // rejected batch therefore leaves no session and no files behind.
  let validated: ValidatedImage[] = [];
  if (files.length > 0) {
    try {
      validated = await validateImages(files);
    } catch (err) {
      if (err instanceof UploadError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      return NextResponse.json({ error: 'Could not read the images.' }, { status: 500 });
    }
  }

  // The UI disables its composer on the same signal; this is the backstop for
  // a stale tab or a direct API call.
  const health = await getAgentHealth();
  if (!health.ready) {
    return NextResponse.json({ error: health.reason }, { status: 503 });
  }

  const attachments = validated.map((v) => v.attachment);
  const session = await createSession({
    prompt,
    period: body.period,
    startingCapital: body.startingCapital,
    attachments,
  });

  // Now that the session (and so its workdir) exists, write the image bytes.
  // If this fails the session would reference files that aren't there, so drop
  // it rather than leave a strategy with broken attachments.
  if (validated.length > 0) {
    try {
      await writeImages(session.id, validated);
    } catch {
      await deleteSession(session.id).catch(() => {});
      return NextResponse.json({ error: 'Could not save the images.' }, { status: 500 });
    }
  }

  try {
    await runManager.startRun(session.id, 'initial', undefined, attachments);
  } catch (err) {
    // fs-prep inside startRun threw before it could route through onRunFailure;
    // don't leave an orphaned `running` session behind. Best-effort mark failed.
    try {
      const failed = (await getSession(session.id)) ?? session;
      failed.status = 'failed';
      await saveSession(failed);
    } catch {
      /* best effort */
    }
    const message = err instanceof Error ? err.message : 'Failed to start the run';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const fresh = (await getSession(session.id)) ?? session;
  return NextResponse.json(fresh, { status: 201 });
}
