// POST /api/sessions/[id]/share — mint (or return) the session's share token,
// START the cloudflared tunnel, and return the finished public link. Idempotent:
// re-sharing reuses the token and the running tunnel.
// DELETE — revoke the token, and stop the tunnel when this was the last shared
// strategy. The public URL stops working immediately either way (revoked token
// ⇒ 404 even while the tunnel drains).

import { nanoid } from 'nanoid';
import type { ShareInfo } from '@/lib/types';
import { isValidSessionId } from '@/lib/server/paths';
import { getSession, listSessions, saveSession } from '@/lib/server/store';
import { isCloudflaredInstalled } from '@/lib/server/cloudflared';
import { tunnelManager } from '@/lib/server/tunnel';


/**
 * The origin the share tunnel exposes: the web front door, whose gate
 * (proxy.ts) confines tunnel visitors to the share page. It must never be this
 * API server's own origin — `request.url` here is the internal address Next
 * forwarded to. Order: HINDSIGHT_WEB_ORIGIN, then the host the browser used
 * (Next's rewrite passes it as X-Forwarded-Host), then the default dev origin.
 */
function webOrigin(request: Request): string {
  const configured = process.env.HINDSIGHT_WEB_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (host) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'http';
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
}

export async function POST(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!session.shareToken) {
    // 32 chars ≈ 190 bits of nanoid entropy — the URL's secrecy is the auth.
    session.shareToken = nanoid(32);
    await saveSession(session);
  }

  if (!(await isCloudflaredInstalled())) {
    const info: ShareInfo = { token: session.shareToken, url: null, cloudflaredInstalled: false };
    return Response.json(info);
  }

  // Tunnel to the WEB origin the browser actually used (handles custom ports).
  let publicOrigin: string;
  try {
    publicOrigin = await tunnelManager.start(webOrigin(request));
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'The tunnel could not be started.' },
      { status: 502 },
    );
  }

  const info: ShareInfo = {
    token: session.shareToken,
    url: `${publicOrigin}/share/${session.shareToken}`,
    cloudflaredInstalled: true,
  };
  return Response.json(info);
}

export async function DELETE(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  if (session.shareToken) {
    session.shareToken = null;
    await saveSession(session);
  }
  // Last share revoked ⇒ nothing left to expose ⇒ close the tunnel.
  const anyShared = (await listSessions()).some((s) => s.shareToken);
  if (!anyShared) tunnelManager.stop();
  return Response.json({ ok: true });
}
