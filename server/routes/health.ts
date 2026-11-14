// GET /api/health — whether the selected agent can actually run a backtest.
// The UI blocks its composers on `ready: false` and shows `reason`/`hint`.

import { getAgentHealth } from '@/lib/server/agent/health';


export async function GET() {
  return Response.json(await getAgentHealth());
}
