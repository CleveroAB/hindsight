// GET /api/mobile/strategies        — every strategy as one display-ready row
// GET /api/mobile/strategies/[id]   — one strategy: figures, chart, chat, live progress
// GET /api/mobile/strategies/[id]/chart — its equity curve to scrub, beside its benchmark
// GET /api/mobile/settings          — the app-wide model and effort, and Codex's choices
//
// The phone app's read side. A full `Session` carries every archived version's
// equity curve and Python source — megabytes the phone would download on each
// poll just to draw a row. These views send only what a screen shows, already
// formatted with the same helpers the web UI uses (lib/format, lib/chart), so
// both clients agree on every figure and curve. Writes go through the regular
// routes (`POST /api/sessions`, `…/messages`, `…/interrupt`, `DELETE …`).
//
// The detail view folds in the live run snapshot, so the app polls ONE
// endpoint while a backtest runs instead of holding an SSE stream open.

import type {
  ChatMessage,
  CodexEffort,
  CodexModelInfo,
  EquityPoint,
  MobileChart,
  MobileChartPoint,
  MobileSettings,
  MobileStrategy,
  MobileStrategyRow,
  Session,
} from '@/lib/types';
import {
  HERO,
  SPARK,
  alignToDates,
  boundsOf,
  cagrPct,
  equityAreaPath,
  equityLinePath,
  maxDrawdownPct,
  normalizeWith,
  sparklinePath,
  type Bounds,
} from '@/lib/chart';
import {
  formatDatePill,
  formatDuration,
  formatElapsed,
  formatMetaLine,
  formatMoney,
  formatMoneyWhole,
  formatSignedMoney,
  formatSignedPercent,
  formatYearRange,
  yearOf,
} from '@/lib/format';
import { parseRichText, type RichSpan } from '@/lib/richText';
import { getAgentHealth, getProviderHealth } from '@/lib/server/agent/health';
import { presentedBenchmark } from '@/lib/server/benchmark';
import { listModels, providerOf } from '@/lib/server/models';
import { isValidSessionId } from '@/lib/server/paths';
import { runManager } from '@/lib/server/runManager';
import { getSettings } from '@/lib/server/settings';
import { getSession, listSessions } from '@/lib/server/store';

/** Points kept for the detail chart — plenty for a phone-width curve. */
const CHART_POINTS = 240;

/** Evenly thin a series to at most `target` items, keeping both endpoints. */
function thin<T>(values: T[], target: number): T[] {
  if (values.length <= target) return values;
  const out: T[] = [];
  for (let i = 0; i < target; i += 1) {
    out.push(values[Math.round((i / (target - 1)) * (values.length - 1))]);
  }
  return out;
}

/** Characters Markdown would read as syntax, escaped so prose stays prose. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>#|~])/g, '\\$1');
}

function spansToMarkdown(spans: RichSpan[]): string {
  return spans
    .map((span) => {
      const text = escapeMarkdown(span.text);
      if (!span.bold || !text.trim()) return text;
      // Emphasis markers must hug the words they wrap.
      const lead = text.match(/^\s*/)?.[0] ?? '';
      const tail = text.match(/\s*$/)?.[0] ?? '';
      return `${lead}**${text.trim()}**${tail}`;
    })
    .join('');
}

/**
 * An agent summary as Markdown. The summary's own subset (lib/richText:
 * blank-line paragraphs, `- ` bullets, `**bold**`, and legacy one-paragraph
 * walls split into readable groups) is parsed exactly as the web renders it,
 * then written out with everything else escaped, so stray `*` or `_` in a
 * ticker or a formula can't restyle the bubble.
 */
export function agentMarkdown(text: string): string {
  return parseRichText(text)
    .map((block) =>
      block.kind === 'list'
        ? block.items.map((item) => `- ${spansToMarkdown(item)}`).join('\n')
        : spansToMarkdown(block.spans),
    )
    .join('\n\n');
}

/** The small line under a bubble: which backtest an answer produced, or what a prompt carried. */
function noteOf(message: ChatMessage): string {
  if (message.role === 'agent' && message.metadata) {
    const parts: string[] = [];
    if (message.metadata.backtestId) parts.push(message.metadata.backtestId);
    if (message.metadata.durationMs > 0) parts.push(formatDuration(message.metadata.durationMs));
    return parts.join(' · ');
  }
  const images = message.attachments?.length ?? 0;
  return images > 0 ? `${images} image${images === 1 ? '' : 's'}` : '';
}

/** A row's title before the agent has named the strategy: the prompt, clipped. */
function titleOf(session: Session): string {
  if (session.name) return session.name;
  const prompt = session.prompt.trim().replace(/\s+/g, ' ');
  return prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt || 'Untitled strategy';
}

export function toRow(session: Session): MobileStrategyRow {
  const result = session.result;
  const values = result ? result.equityCurve.map((p) => p.value) : [];
  return {
    id: session.id,
    name: titleOf(session),
    description: session.description,
    status: session.status,
    hasResult: result !== null,
    returnPct: result ? result.returnPct : 0,
    returnText: result ? formatSignedPercent(result.returnPct) : '',
    valueText: result ? formatMoney(result.finalValue) : '',
    periodText: formatYearRange(session.period.start, session.period.end),
    spark: values.length > 1 ? sparklinePath(values) : '',
    sparkBox: `0 0 ${SPARK.w} ${SPARK.h}`,
    updatedAt: session.updatedAt,
  };
}

/** A model's display name among Codex's choices; its id when it is not one of them. */
function nameOf(id: string, models: CodexModelInfo[]): string {
  return models.find((m) => m.id === id)?.name ?? id;
}

/**
 * `modelName` is the model the strategy's next run will use, by name — its
 * own, else the app-wide one; '' when no model is called (the mock agent).
 */
export function toDetail(session: Session, modelName = '', agentName = ''): MobileStrategy {
  const result = session.result;
  const values = result ? thin(result.equityCurve, CHART_POINTS).map((p) => p.value) : [];
  const live = runManager.liveSnapshot(session.id);
  return {
    ...toRow(session),
    prompt: session.prompt,
    start: session.period.start,
    end: session.period.end,
    changeText: result ? formatSignedMoney(result.finalValue - result.startingCapital) : '',
    metaText: formatMetaLine(session.period.start, session.period.end, session.startingCapital),
    chartLine: values.length > 1 ? equityLinePath(values) : '',
    chartArea: values.length > 1 ? equityAreaPath(values) : '',
    chartBox: `0 0 ${HERO.w} ${HERO.h}`,
    resultKey: result ? String(result.ranAt) : '',
    model: session.model ?? '',
    modelName,
    agentName,
    messages: session.chat.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.role === 'agent' ? agentMarkdown(m.text) : m.text,
      note: noteOf(m),
    })),
    steps: live ? live.steps.map((s) => ({ id: s.id, label: s.label, done: s.state === 'done' })) : [],
    statusLabel: live?.status_line?.label ?? '',
    elapsedText: live?.status_line ? formatElapsed(live.status_line.elapsedMs) : '',
  };
}

/** Where a normalized value sits from the top of the plot, 0 to 1 — as `pointsToPath` draws it. */
function fromTop(normalized: number): number {
  return (HERO.h - HERO.pad - normalized * (HERO.h - 2 * HERO.pad)) / HERO.h;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Year labels along the period, at most seven, as the web chart's axis has them. */
function yearTicks(start: string, end: string): { label: string; at: number }[] {
  const a = yearOf(start);
  const b = yearOf(end);
  if (!Number.isFinite(a)) return Number.isFinite(b) ? [{ label: String(b), at: 1 }] : [];
  if (!Number.isFinite(b) || b <= a) return [{ label: String(a), at: 0 }];
  const t0 = Date.parse(start);
  const t1 = Date.parse(end);
  const step = Math.max(1, Math.ceil((b - a) / 4));
  const ticks = [{ label: String(a), at: 0 }];
  for (let y = a + step; y < b; y += step) {
    const at = (Date.parse(`${y}-01-01`) - t0) / (t1 - t0);
    if (at > 0.12 && at < 0.88) ticks.push({ label: String(y), at: round4(at) });
  }
  ticks.push({ label: String(b), at: 1 });
  return ticks;
}

/**
 * The chart of a session's result. `benchmark` is the comparable asset's
 * buy-and-hold curve, or null when it could not be loaded (`benchError` says
 * why); it is forward-filled onto the strategy's own trading days.
 */
export function toChart(
  session: Session,
  benchmark: { ticker: string; reason: string; curve: EquityPoint[] } | null,
  benchError = '',
): MobileChart {
  const result = session.result;
  const curve = result ? thin(result.equityCurve, CHART_POINTS) : [];
  const values = curve.map((p) => p.value);
  const start = result?.startingCapital ?? session.startingCapital;
  const benchValues =
    benchmark && values.length > 1 ? alignToDates(curve.map((p) => p.date), benchmark.curve) : [];
  const compared = benchValues.length === values.length && values.length > 1;

  const own: Bounds = boundsOf(values);
  const shared: Bounds = compared ? boundsOf(values, benchValues) : own;
  const ownY = normalizeWith(values, own).map(fromTop);
  const sharedY = normalizeWith(values, shared).map(fromTop);
  const benchY = compared ? normalizeWith(benchValues, shared).map(fromTop) : [];
  const pct = (value: number) => (start !== 0 ? (value / start - 1) * 100 : 0);

  const points: MobileChartPoint[] = curve.map((p, i) => ({
    date: formatDatePill(p.date),
    value: formatMoney(p.value),
    change: formatSignedPercent(pct(p.value)),
    up: p.value >= start,
    bench: compared ? formatMoney(benchValues[i]) : '',
    benchChange: compared ? formatSignedPercent(pct(benchValues[i])) : '',
    y: round4(ownY[i]),
    sharedY: round4(sharedY[i]),
    benchY: compared ? round4(benchY[i]) : 0,
  }));

  const benchReturn = compared ? pct(benchValues[benchValues.length - 1]) : 0;
  const edge = result ? result.returnPct - benchReturn : 0;
  const stats: { label: string; value: string }[] = [];
  if (result) {
    stats.push({ label: 'Total return', value: formatSignedPercent(result.returnPct) });
    const cagr = cagrPct(result);
    if (cagr !== null) stats.push({ label: 'Annualized', value: formatSignedPercent(cagr) });
    const drawdown = maxDrawdownPct(result.equityCurve.map((p) => p.value));
    if (drawdown !== null) {
      // A curve that never fell has no sign to show.
      stats.push({ label: 'Max drawdown', value: drawdown < -0.05 ? formatSignedPercent(drawdown) : '0.0%' });
    }
    if (compared && benchmark) {
      stats.push({ label: `${benchmark.ticker} buy & hold`, value: formatSignedPercent(benchReturn) });
    }
    stats.push({ label: 'Starting capital', value: formatMoneyWhole(start) });
    stats.push({ label: 'Final value', value: formatMoney(result.finalValue) });
    stats.push({
      label: 'Period',
      value: `${formatDatePill(session.period.start)} – ${formatDatePill(session.period.end)}`,
    });
  }

  return {
    id: session.id,
    key: result ? String(result.ranAt) : '',
    box: `0 0 ${HERO.w} ${HERO.h}`,
    line: values.length > 1 ? equityLinePath(values) : '',
    area: values.length > 1 ? equityAreaPath(values) : '',
    sharedLine: compared ? equityLinePath(values, shared) : '',
    sharedArea: compared ? equityAreaPath(values, shared) : '',
    benchLine: compared ? equityLinePath(benchValues, shared) : '',
    ticker: compared && benchmark ? benchmark.ticker : '',
    benchReturnText: compared ? formatSignedPercent(benchReturn) : '',
    benchUp: benchReturn >= 0,
    benchReason: compared && benchmark ? benchmark.reason : '',
    edgeText:
      compared && benchmark
        ? `${edge >= 0 ? 'Beat' : 'Trailed'} ${benchmark.ticker} by ${Math.abs(edge).toFixed(1)} points`
        : '',
    ahead: edge >= 0,
    benchError: compared ? '' : benchError,
    points,
    ticks: yearTicks(session.period.start, session.period.end),
    stats,
  };
}

export async function LIST() {
  const sessions = await listSessions();
  return Response.json(sessions.map(toRow));
}

export async function DETAIL(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  let modelName = '';
  let agentName = '';
  if (process.env.HINDSIGHT_AGENT === 'codex') {
    const [settings, catalog] = await Promise.all([getSettings(), listModels()]);
    const model = session.model || settings.model;
    modelName = nameOf(model, catalog.models);
    agentName = AGENT_NAMES[providerOf(model)];
  }
  return Response.json(toDetail(session, modelName, agentName));
}

export async function CHART(_request: Request, { params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  if (!isValidSessionId(params.id)) {
    return Response.json({ error: 'Invalid session id' }, { status: 400 });
  }
  const session = await getSession(params.id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!session.result) return Response.json(toChart(session, null));
  // The curve is the answer; the comparison is an extra that needs live price
  // data, so its failure is said in words beside a chart that still draws.
  try {
    return Response.json(toChart(session, await presentedBenchmark(session)));
  } catch (err) {
    console.warn(`[mobile] comparison unavailable for ${session.id}:`, err instanceof Error ? err.message : err);
    return Response.json(toChart(session, null, 'Comparison unavailable right now.'));
  }
}

const EFFORT_NAMES: Record<CodexEffort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

const AGENT_NAMES = { codex: 'Codex', claude: 'Claude Code' } as const;

export async function SETTINGS() {
  const [settings, catalog, health, codex, claude] = await Promise.all([
    getSettings(),
    listModels(),
    getAgentHealth(),
    getProviderHealth('codex'),
    getProviderHealth('claude'),
  ]);
  const current = catalog.models.find((m) => m.id === settings.model);
  // An effort the current model doesn't list is still shown, so the picker
  // never lacks the value that is in force.
  const efforts = current?.efforts ?? [];
  const shown = efforts.includes(settings.effort) ? efforts : [...efforts, settings.effort];
  const mock = health.agent === 'mock';
  const body: MobileSettings = {
    agent: health.agent,
    ready: health.ready,
    status: health.ready
      ? mock
        ? 'Mock agent · runs are simulated'
        : `${AGENT_NAMES[health.provider ?? 'codex']} · signed in`
      : (health.reason ?? 'Runs can’t start right now.'),
    agents: mock
      ? [{ name: 'Mock agent', status: 'Runs are simulated', ready: true }]
      : [
          { name: AGENT_NAMES.codex, status: codex.ready ? 'Signed in' : 'Not signed in', ready: codex.ready },
          { name: AGENT_NAMES.claude, status: claude.ready ? 'Signed in' : 'Not signed in', ready: claude.ready },
        ],
    model: settings.model,
    modelName: current?.name ?? settings.model,
    modelOffered: current !== undefined,
    effort: settings.effort,
    models: catalog.models.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      group: mock ? 'Mock agent' : AGENT_NAMES[m.provider],
    })),
    efforts: shown.map((id) => ({ id, name: EFFORT_NAMES[id] })),
  };
  return Response.json(body);
}
