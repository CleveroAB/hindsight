// GET /api/health — whether the selected agent can actually run a backtest.
// The UI blocks its composers on `ready: false` and shows `reason`/`hint`.

import { NextResponse } from 'next/server';
import { getAgentHealth } from '@/lib/server/agent/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await getAgentHealth());
}
