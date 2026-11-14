// ============================================================================
// Next's front door (`proxy.ts` is the Next 16+ name for this file convention;
// on Next 14/15 it was `middleware.ts` exporting `middleware()`; it runs on
// the Node.js runtime by default). All of the policy lives in `lib/gate.ts`,
// shared with the Bun API server — this file only adapts its verdict to Next.
// ============================================================================

import { NextResponse, type NextRequest } from 'next/server';
import { frontDoor } from '@/lib/gate';

export async function proxy(request: NextRequest): Promise<Response> {
  return (await frontDoor(request)) ?? NextResponse.next();
}
