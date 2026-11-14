// ============================================================================
// The route table (PROTOCOL.md §6): path pattern → method → handler. Patterns
// use Bun's `:param` syntax. Handlers are plain `(Request, { params })`
// functions returning a web-standard `Response`, one module per resource under
// `routes/`, so they can be called directly in tests.
// ============================================================================

import * as activate from './routes/activate';
import * as activateCheck from './routes/activate-check';
import * as attachment from './routes/attachment';
import * as benchmark from './routes/benchmark';
import * as health from './routes/health';
import * as ideas from './routes/ideas';
import * as interrupt from './routes/interrupt';
import * as messages from './routes/messages';
import * as mobile from './routes/mobile';
import * as models from './routes/models';
import * as sessionModel from './routes/session-model';
import * as rerun from './routes/rerun';
import * as session from './routes/session';
import * as sessions from './routes/sessions';
import * as settings from './routes/settings';
import * as shareLink from './routes/share-link';
import * as sharePage from './routes/share-page';
import * as signals from './routes/signals';
import * as stream from './routes/stream';

// `any` for the params bag: each handler declares the params its own pattern
// provides, and the table is where pattern and handler are paired.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (request: Request, context: { params: Promise<any> }) => Promise<Response> | Response;

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export const ROUTES: Record<string, Partial<Record<Method, Handler>>> = {
  '/api/health': { GET: health.GET },
  '/api/settings': { GET: settings.GET, PUT: settings.PUT },
  '/api/signals': { GET: signals.GET },

  '/api/sessions': { GET: sessions.GET, POST: sessions.POST },
  '/api/sessions/:id': { GET: session.GET, DELETE: session.DELETE },
  '/api/sessions/:id/model': { PUT: sessionModel.PUT },
  '/api/sessions/:id/stream': { GET: stream.GET },
  '/api/sessions/:id/messages': { POST: messages.POST },
  '/api/sessions/:id/rerun': { POST: rerun.POST },
  '/api/sessions/:id/interrupt': { POST: interrupt.POST },
  '/api/sessions/:id/benchmark': { GET: benchmark.GET },
  '/api/sessions/:id/attachments/:name': { GET: attachment.GET },
  '/api/sessions/:id/share': { POST: shareLink.POST, DELETE: shareLink.DELETE },
  '/api/sessions/:id/activate': { POST: activate.POST, DELETE: activate.DELETE },
  '/api/sessions/:id/activate/check': { POST: activateCheck.POST },

  // Compact, display-ready views for the phone app (same data, a fraction of
  // the bytes — a full Session carries every version's curve and source).
  '/api/models': { GET: models.GET },
  '/api/ideas': { POST: ideas.POST },
  '/api/mobile/settings': { GET: mobile.SETTINGS },
  '/api/mobile/strategies': { GET: mobile.LIST },
  '/api/mobile/strategies/:id': { GET: mobile.DETAIL },
  '/api/mobile/strategies/:id/chart': { GET: mobile.CHART },

  '/share/:token': { GET: sharePage.GET },
};
