// POST /api/sessions/[id]/share — mint (or return) the session's share token,
// START the cloudflared tunnel, and return the finished public link. Idempotent:
// re-sharing reuses the token and the running tunnel.
// DELETE — revoke the token, and stop the tunnel when this was the last shared
// strategy. The public URL stops working immediately either way (revoked token
// ⇒ 404 even while the tunnel drains).

import { NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import type { ShareInfo } from '@/lib/types';
import { isValidSessionId } from '@/lib/server/paths';
import { getSession, listSessions, saveSession } from '@/lib/server/store';
import { isCloudflaredInstalled } from '@/lib/server/cloudflared';
import { tunnelManager } from '@/lib/server/tunnel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!session.shareToken) {
    // 32 chars ≈ 190 bits of nanoid entropy — the URL's secrecy is the auth.
    session.shareToken = nanoid(32);
    await saveSession(session);
  }

  if (!(await isCloudflaredInstalled())) {
    const info: ShareInfo = { token: session.shareToken, url: null, cloudflaredInstalled: false };
    return NextResponse.json(info);
  }

  // Tunnel to whatever origin this request actually hit (handles custom ports).
  let publicOrigin: string;
  try {
    publicOrigin = await tunnelManager.start(new URL(request.url).origin);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'The tunnel could not be started.' },
      { status: 502 },
    );
  }

  const info: ShareInfo = {
    token: session.shareToken,
    url: `${publicOrigin}/share/${session.shareToken}`,
    cloudflaredInstalled: true,
  };
  return NextResponse.json(info);
}

export async function DELETE(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return NextResponse.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.shareToken) {
    session.shareToken = null;
    await saveSession(session);
  }
  // Last share revoked ⇒ nothing left to expose ⇒ close the tunnel.
  const anyShared = (await listSessions()).some((s) => s.shareToken);
  if (!anyShared) tunnelManager.stop();
  return NextResponse.json({ ok: true });
}
