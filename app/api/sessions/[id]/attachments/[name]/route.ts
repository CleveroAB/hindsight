// GET /api/sessions/[id]/attachments/[name] — serve an image the user attached
// to a chat message, so the browser can render it back in the bubble.
//
// `name` must be a server-generated upload filename; uploadFile() rejects
// anything else, so no request can reach outside the session's uploads dir.

import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { isValidSessionId, uploadFile } from '@/lib/server/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export async function GET(
  _request: Request,
  { params: paramsPromise }: { params: Promise<{ id: string; name: string }> },
) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const file = uploadFile(params.id, params.name);
  if (!file) {
    return NextResponse.json({ error: 'Invalid attachment name' }, { status: 400 });
  }

  // A plain ArrayBuffer, not the Buffer: Buffer/Uint8Array don't satisfy this
  // runtime's BodyInit. The slice also detaches it from Node's shared pool.
  let bytes: ArrayBuffer;
  try {
    const buf = await readFile(file);
    bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  }

  const ext = params.name.slice(params.name.lastIndexOf('.') + 1);
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
      // Content is immutable (names are unique per upload) but session-private,
      // so keep it out of shared caches.
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
