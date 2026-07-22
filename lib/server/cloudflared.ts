// ============================================================================
// Is the `cloudflared` CLI available on this machine? The share dialog warns
// when it isn't — a share link is useless without a tunnel to expose it.
// Checked by actually spawning `cloudflared --version` (PATH lookup included);
// ENOENT ⇒ not installed. Cached briefly so opening the dialog doesn't spawn
// a process every time.
// ============================================================================

import { execFile } from 'node:child_process';

const CACHE_TTL_MS = 60_000;

let cached: { at: number; installed: boolean } | null = null;

function probe(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile('cloudflared', ['--version'], { timeout: 3000 }, (err) => {
        // Any successful spawn counts — even a non-zero exit means the binary
        // exists. Only a spawn failure (ENOENT etc.) means "not installed".
        resolve(!err || (err as NodeJS.ErrnoException).code !== 'ENOENT');
      });
    } catch {
      resolve(false);
    }
  });
}

/** True if `cloudflared` is on PATH (cached for a minute). */
export async function isCloudflaredInstalled(): Promise<boolean> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.installed;
  const installed = await probe();
  cached = { at: now, installed };
  return installed;
}
