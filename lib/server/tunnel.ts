// ============================================================================
// Cloudflared quick-tunnel manager. The Share button starts the tunnel and the
// UI shows only the finished public link; Stop sharing tears it down again —
// the user never runs `cloudflared` by hand.
//
// One tunnel per server process (it exposes the whole origin, gated by
// proxy.ts), shared by however many strategies are shared at once; the share
// route stops it when the LAST share is revoked. A quick tunnel prints its
// random https://*.trycloudflare.com URL on stderr shortly after launch; we
// resolve once that line appears, or fail after a timeout.
//
// State lives on globalThis (same pattern as runManager) so `next dev` module
// reloads never orphan a running cloudflared process.
// ============================================================================

import { spawn, type ChildProcess } from 'node:child_process';

/** How long to wait for cloudflared to print the public URL. */
const START_TIMEOUT_MS = 20_000;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

class TunnelManager {
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;

  constructor() {
    // Best effort: don't leave a stray cloudflared behind when the server dies.
    process.once('exit', () => this.stop());
  }

  /** Public origin of the running tunnel, or null. */
  get publicUrl(): string | null {
    return this.proc ? this.url : null;
  }

  /**
   * Ensure a tunnel to `target` (e.g. http://localhost:3000) is up and return
   * its public origin. Reuses a live tunnel; concurrent callers share one spawn.
   */
  async start(target: string): Promise<string> {
    if (this.proc && this.url) return this.url;
    if (this.starting) return this.starting;
    this.starting = this.spawnTunnel(target).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Kill the tunnel (idempotent). The public URL dies with it. */
  stop(): void {
    const proc = this.proc;
    this.proc = null;
    this.url = null;
    try {
      proc?.kill();
    } catch {
      /* already gone */
    }
  }

  private spawnTunnel(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let output = '';

      const proc = spawn('cloudflared', ['tunnel', '--url', target], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('cloudflared did not report a tunnel URL within 20s.'));
      }, START_TIMEOUT_MS);

      // The URL announcement goes to stderr; watch both streams to be safe.
      const onData = (chunk: Buffer) => {
        if (settled) return;
        output += chunk.toString('utf8');
        const m = output.match(URL_RE);
        if (m) {
          settled = true;
          clearTimeout(timer);
          this.proc = proc;
          this.url = m[0];
          // If cloudflared later dies (network drop, manual kill), forget it so
          // the next Share press starts a fresh one.
          proc.on('exit', () => {
            if (this.proc === proc) {
              this.proc = null;
              this.url = null;
            }
          });
          resolve(m[0]);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(
          new Error(
            missing
              ? 'cloudflared is not installed.'
              : `cloudflared failed to start: ${err.message}`,
          ),
        );
      });

      proc.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared exited (code ${code}) before reporting a URL.` +
              (output ? `\n${output.slice(-400)}` : ''),
          ),
        );
      });
    });
  }
}

const g = globalThis as unknown as { __hindsightTunnel?: TunnelManager };
export const tunnelManager: TunnelManager = (g.__hindsightTunnel ??= new TunnelManager());
