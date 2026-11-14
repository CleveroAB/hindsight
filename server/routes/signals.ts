// GET /api/signals — the activation overview: the default phone + provider the
// activate flow will use, plus every currently activated strategy. Touching it
// also (re)boots the signal scheduler — the fallback for a process whose
// server's boot-time init was skipped (init is idempotent).

import type { ActiveSignalEntry, SignalsOverview } from '@/lib/types';
import { listSessions } from '@/lib/server/store';
import { normalizePhone, signalProvider } from '@/lib/server/signals/messenger';
import { getSignalScheduler } from '@/lib/server/signals/scheduler';


export async function GET() {
  getSignalScheduler().init();
  const active: ActiveSignalEntry[] = [];
  for (const session of await listSessions()) {
    const activation = session.activation;
    if (!activation) continue;
    active.push({
      sessionId: session.id,
      name: session.name,
      cadence: activation.cadence,
      cadenceReason: activation.cadenceReason,
      nextCheckAt: activation.nextCheckAt,
      lastSignal: activation.lastSignal,
    });
  }
  const overview: SignalsOverview = {
    defaultPhone: normalizePhone(process.env.HINDSIGHT_SIGNAL_PHONE),
    provider: signalProvider(),
    active,
  };
  return Response.json(overview);
}
