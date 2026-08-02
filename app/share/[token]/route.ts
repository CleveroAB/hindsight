// GET /share/[token] — the read-only shared-strategy page. A Route Handler
// (not a React page) returning one self-contained HTML document, so tunnel
// visitors need no /_next assets, no API access, no JavaScript — proxy.ts
// can therefore allowlist exactly this path and 404 everything else.

import { findSessionByShareToken } from '@/lib/server/store';
import { renderSharePage, renderShareNotFound } from '@/lib/server/sharePage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex',
} as const;

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await findSessionByShareToken(token);
  if (!session) {
    return new Response(renderShareNotFound(), { status: 404, headers: HTML_HEADERS });
  }
  // The public page must never carry activation state — it holds the user's
  // phone number. The renderer only reads whitelisted fields today; stripping
  // here keeps that guaranteed even if it grows.
  delete session.activation;
  return new Response(renderSharePage(session), { status: 200, headers: HTML_HEADERS });
}
