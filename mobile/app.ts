// Hindsight for iPhone: the data module. It keeps the list of strategies and answers what
// app.contract asks, by calling the Hindsight API server (../server): the compact
// `/api/mobile/*` views to read, the regular `/api/sessions` routes to write.
import type { Answer, Result, Sources } from './app.contract.d.ts';

// Where the server is. A build for a phone names its HTTPS address in API_BASE_URL (app.json's
// `env`; `tools/ship.sh` sets it); with none, the app talks to the mock-agent harness
// `bun server.ts` runs on this machine, which is also what `test` and `verify` start.
export const API = import.meta.env.API_BASE_URL ?? 'http://127.0.0.1:8797';
export const grants = `net.fetch ${API}`;

type Row = Result<'loadStrategies'>[number];
type Detail = Result<'loadStrategy'>;
type Chart = Result<'loadChart'>;
type Settings = Result<'loadSettings'>;
type Idea = Result<'loadIdeas'>[number];
type Reply = Result<'createStrategy'>;

// The list. Every read replaces it with the server's; a write the server accepted is applied
// here at once, so the screen is right before the next read lands.
let strategies: Row[] = [];

// The brainstorm in the New Strategy sheet: the conversation so far. It is kept here, sent
// whole with each message (the server keeps none), and forgotten when the sheet is opened
// afresh. An assistant's `strategy` is its draft of the idea at that point.
let ideas: Idea[] = [];

const UNREACHABLE = 'Can’t reach your Hindsight server. Check that this phone is on your tailnet, then try again.';

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    exactTimeout: 15000,
    headers: init.body ? { 'content-type': 'application/json' } : {},
  });
}

type Answered = { ok: true; body: unknown } | { ok: false; error: string };

// A write: the server's refusal (`{ error }`) or a lost connection comes back in words, so a
// form keeps what was typed and says why.
async function call(path: string, init: RequestInit): Promise<Answered> {
  try {
    const res = await request(path, init);
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (res.ok) return { ok: true, body };
    return { ok: false, error: typeof body.error === 'string' ? body.error : 'The server had a problem. Try again.' };
  } catch (e) {
    if ((e as { code?: string }).code === 'bake') throw e; // no server at build
    return { ok: false, error: UNREACHABLE };
  }
}

const reply = (r: Answered): Reply => (r.ok ? { ok: true, error: '' } : { ok: false, error: r.error });

// A read: anything but the expected body fails the resource, and Exact keeps the last answer.
async function read(path: string): Promise<unknown> {
  const res = await request(path);
  if (!res.ok) throw new Error(`The server answered ${res.status}.`);
  return res.json();
}

const str = (v: unknown): v is string => typeof v === 'string';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

function toRow(v: unknown): Row {
  if (!record(v) || !str(v.id) || !str(v.name) || !str(v.description) || !str(v.status) ||
    typeof v.hasResult !== 'boolean' || typeof v.returnPct !== 'number' || !str(v.returnText) ||
    !str(v.valueText) || !str(v.periodText) || !str(v.spark) || !str(v.sparkBox)) {
    throw new Error('The server returned an invalid strategy.');
  }
  return {
    id: v.id, name: v.name, description: v.description, status: v.status, hasResult: v.hasResult,
    up: v.returnPct >= 0, returnText: v.returnText, valueText: v.valueText, periodText: v.periodText,
    spark: v.spark, sparkBox: v.sparkBox,
  };
}

function toDetail(v: unknown): Detail {
  const row = toRow(v);
  if (!record(v) || !str(v.changeText) || !str(v.metaText) || !str(v.resultKey) || !str(v.model) || !str(v.modelName) || !str(v.agentName) || !str(v.chartLine) || !str(v.chartArea) ||
    !str(v.chartBox) || !Array.isArray(v.messages) || !Array.isArray(v.steps) ||
    !str(v.statusLabel) || !str(v.elapsedText)) {
    throw new Error('The server returned an invalid strategy.');
  }
  return {
    id: row.id, name: row.name, status: row.status, hasResult: row.hasResult, up: row.up,
    returnText: row.returnText, valueText: row.valueText, changeText: v.changeText, metaText: v.metaText, resultKey: v.resultKey, model: v.model, modelName: v.modelName, agentName: v.agentName,
    chartLine: v.chartLine, chartArea: v.chartArea, chartBox: v.chartBox,
    messages: v.messages.map((m: unknown) => {
      if (!record(m) || !str(m.id) || !str(m.role) || !str(m.text) || !str(m.note)) throw new Error('The server returned an invalid message.');
      return { id: m.id, role: m.role, text: m.text, note: m.note };
    }),
    steps: v.steps.map((s: unknown) => {
      if (!record(s) || !str(s.id) || !str(s.label) || typeof s.done !== 'boolean') throw new Error('The server returned an invalid step.');
      return { id: s.id, label: s.label, done: s.done };
    }),
    statusLabel: v.statusLabel, elapsedText: v.elapsedText,
  };
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function toChart(v: unknown): Chart {
  if (!record(v) || !str(v.id) || !str(v.key) || !str(v.box) || !str(v.line) || !str(v.area) ||
    !str(v.sharedLine) || !str(v.sharedArea) || !str(v.benchLine) || !str(v.ticker) ||
    !str(v.benchReturnText) || !str(v.benchReason) || !str(v.edgeText) || !str(v.benchError) ||
    !Array.isArray(v.points) || !Array.isArray(v.ticks) || !Array.isArray(v.stats)) {
    throw new Error('The server returned an invalid chart.');
  }
  return {
    id: v.id, key: v.key, box: v.box, line: v.line, area: v.area, sharedLine: v.sharedLine,
    sharedArea: v.sharedArea, benchLine: v.benchLine, ticker: v.ticker, benchReturnText: v.benchReturnText,
    benchReason: v.benchReason, edgeText: v.edgeText, benchError: v.benchError,
    points: v.points.map((p: unknown) => {
      if (!record(p) || !str(p.date) || !str(p.value) || !str(p.change) || typeof p.up !== 'boolean' ||
        !str(p.bench) || !str(p.benchChange) || !num(p.y) || !num(p.sharedY) || !num(p.benchY)) {
        throw new Error('The server returned an invalid chart point.');
      }
      return {
        date: p.date, value: p.value, change: p.change, up: p.up, bench: p.bench,
        benchChange: p.benchChange, y: p.y, sharedY: p.sharedY, benchY: p.benchY,
      };
    }),
    ticks: v.ticks.map((t: unknown) => {
      if (!record(t) || !str(t.label) || !num(t.at)) throw new Error('The server returned an invalid chart tick.');
      return { label: t.label, at: t.at };
    }),
    stats: v.stats.map((t: unknown) => {
      if (!record(t) || !str(t.label) || !str(t.value)) throw new Error('The server returned an invalid figure.');
      return { label: t.label, value: t.value };
    }),
  };
}

function toSettings(v: unknown): Settings {
  if (!record(v) || !str(v.agent) || typeof v.ready !== 'boolean' || !str(v.status) || !str(v.model) ||
    !str(v.modelName) || typeof v.modelOffered !== 'boolean' || !str(v.effort) ||
    !Array.isArray(v.agents) || !Array.isArray(v.models) || !Array.isArray(v.efforts)) {
    throw new Error('The server returned invalid settings.');
  }
  return {
    agent: v.agent, ready: v.ready, status: v.status, model: v.model, modelName: v.modelName,
    modelOffered: v.modelOffered, effort: v.effort,
    agents: v.agents.map((a: unknown) => {
      if (!record(a) || !str(a.name) || !str(a.status) || typeof a.ready !== 'boolean') throw new Error('The server returned an invalid agent.');
      return { name: a.name, status: a.status, ready: a.ready };
    }),
    models: v.models.map((m: unknown) => {
      if (!record(m) || !str(m.id) || !str(m.name) || !str(m.description) || !str(m.group)) throw new Error('The server returned an invalid model.');
      return { id: m.id, name: m.name, description: m.description, group: m.group };
    }),
    efforts: v.efforts.map((e: unknown) => {
      if (!record(e) || !str(e.id) || !str(e.name)) throw new Error('The server returned an invalid effort.');
      return { id: e.id, name: e.name };
    }),
  };
}

const sources: Sources = {
  loadStrategies: async () => {
    const body = await read('/api/mobile/strategies');
    if (!Array.isArray(body)) throw new Error('The server returned an invalid list.');
    strategies = body.map(toRow);
    return strategies;
  },
  loadStrategy: async ([id]) => toDetail(await read(`/api/mobile/strategies/${encodeURIComponent(id)}`)),
  // `key` names the result the chart is for: a finished run is a new key, so a new question.
  loadChart: async ([id]) => toChart(await read(`/api/mobile/strategies/${encodeURIComponent(id)}/chart`)),
  loadIdeas: () => ideas,
  // The person's message joins the conversation only once it has been answered, so a
  // failed send leaves the thread as it was and the words in the field.
  sendIdea: async ([text, model]) => {
    const asked = [...ideas.map((m) => ({ role: m.role, text: m.text })), { role: 'user', text }];
    const answered = await call('/api/ideas', {
      method: 'POST',
      body: JSON.stringify(model ? { messages: asked, model } : { messages: asked }),
    });
    if (!answered.ok) return reply(answered);
    const body = answered.body as { reply?: unknown; strategy?: unknown };
    if (!str(body.reply) || !str(body.strategy)) return { ok: false, error: 'The server had a problem. Try again.' };
    const n = ideas.length;
    ideas = [
      ...ideas,
      { id: `idea-${n + 1}`, role: 'user', text, strategy: '' },
      { id: `idea-${n + 2}`, role: 'assistant', text: body.reply, strategy: body.strategy },
    ];
    return { ok: true, error: '' };
  },
  resetIdeas: () => {
    ideas = [];
    return { ok: true, error: '' };
  },
  loadSettings: async () => toSettings(await read('/api/mobile/settings')),
  // `model` is "" for a strategy that follows the app-wide setting.
  createStrategy: async ([prompt, model]) =>
    reply(await call('/api/sessions', { method: 'POST', body: JSON.stringify(model ? { prompt, model } : { prompt }) })),
  setModel: async ([model]) => reply(await call('/api/settings', { method: 'PUT', body: JSON.stringify({ model }) })),
  setEffort: async ([effort]) => reply(await call('/api/settings', { method: 'PUT', body: JSON.stringify({ effort }) })),
  setStrategyModel: async ([id, model]) =>
    reply(await call(`/api/sessions/${encodeURIComponent(id)}/model`, { method: 'PUT', body: JSON.stringify({ model: model || null }) })),
  refineStrategy: async ([id, text]) =>
    reply(await call(`/api/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text }) })),
  stopStrategy: async ([id]) => reply(await call(`/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST' })),
  removeStrategy: async ([id]) => {
    const answered = await call(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (answered.ok) strategies = strategies.filter((s) => s.id !== id);
    return reply(answered);
  },
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
