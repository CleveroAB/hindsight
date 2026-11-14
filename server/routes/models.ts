// GET /api/models — the models a run may use, as Codex offers them to the
// signed-in account (lib/server/models). The settings UIs build their pickers
// from this instead of a list of their own.

import { listModels } from '@/lib/server/models';

export async function GET() {
  return Response.json(await listModels());
}
