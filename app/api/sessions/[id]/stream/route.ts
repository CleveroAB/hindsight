// GET /api/sessions/[id]/stream — Server-Sent Events for a session's run.
//
// First frame is always a `snapshot` (RunSnapshot); then one frame per
// ProgressEvent (`event: <type>`), plus a `: ping` heartbeat every ~15s. See
// PROTOCOL.md §7. The run manager owns fan-out; this route just wires a
// subscriber to a ReadableStream and cleans up on abort.

import type { SseFrame } from '@/lib/server/runManager';
import { runManager } from '@/lib/server/runManager';
import { isValidSessionId } from '@/lib/server/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return new Response('Invalid session id', { status: 400 });
  }
  const sessionId = params.id;
  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed; ignore.
        }
      };

      const send = (frame: SseFrame): void => {
        write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed; ignore.
        }
      };

      // Retry hint for the browser's EventSource on reconnect.
      write('retry: 3000\n\n');

      // Subscribing immediately emits the snapshot frame, then live frames.
      unsubscribe = runManager.subscribe(sessionId, send);

      heartbeat = setInterval(() => write(': ping\n\n'), 15000);

      if (request.signal.aborted) cleanup();
      else request.signal.addEventListener('abort', cleanup);
    },
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
