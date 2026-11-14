// ============================================================================
// Hindsight — shared type contract
// ----------------------------------------------------------------------------
// This file is THE contract between the frontend, the backend/API, and the
// agent layer. Do not change a shape here without updating PROTOCOL.md and all
// three consumers. Everything below is imported by both client and server, so
// keep it free of server-only imports.
// ============================================================================

/** A run's lifecycle state. Persisted on the session. */
export type RunStatus = 'running' | 'done' | 'failed';

/** ISO calendar dates, `YYYY-MM-DD`. Inclusive range. */
export interface Period {
  start: string;
  end: string;
}

/** One point on an equity curve. `date` is `YYYY-MM-DD`; `value` is portfolio $. */
export interface EquityPoint {
  date: string;
  value: number;
}

/**
 * Target portfolio at one bar's close — what the strategy HOLDS after acting on
 * that bar's signals. `date` is `YYYY-MM-DD`; `weights` maps ticker → fraction
 * of portfolio value (0..1; cash implied by a sum below 1; negative = short).
 */
export interface PositionsPoint {
  date: string;
  weights: Record<string, number>;
}

/** How the comparable asset was selected for one accepted strategy version. */
export type BenchmarkSelectionSource = 'agent' | 'strategy' | 'fallback' | 'override';

export type ChatRole = 'user' | 'agent' | 'system';

/**
 * An image attached to a user message — the opening prompt or a later chat
 * refinement (a chart screenshot, a table, a whiteboard photo). Stored under
 * the session's workdir at `uploads/<name>`,
 * which is mounted into the agent container, and handed to Codex via `-i`.
 */
export interface Attachment {
  /** Server-generated filename within the session's uploads dir, e.g. `k3f9….png`. */
  name: string;
  /** The client's original filename — used for alt text and tooltips only. */
  originalName: string;
  /** One of the accepted image types (see ACCEPTED_IMAGE_TYPES). */
  mimeType: string;
  /** Bytes on disk. */
  size: number;
}

/** Run details attached to the successful agent response they describe. */
export interface AgentResponseMetadata {
  /** Wall-clock duration of the completed run, in milliseconds. */
  durationMs: number;
  /** Exact Codex model used, or null when this was a mock/saved-code run. */
  model: string | null;
  /** Exact reasoning effort used, or null when no model was involved. */
  effort: CodexEffort | null;
  /**
   * Which agent produced the response (`codex` or `claude`), or why no model
   * was involved, so the UI can explain a null model accurately.
   */
  mode: 'codex' | 'claude' | 'mock' | 'saved-code' | 'legacy';
  /** Copyable, session-scoped version id, e.g. `BT-003`. */
  backtestId?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Plain text. Agent + user messages render as chat; system as a muted note. */
  text: string;
  /** Images sent with this message. User messages only; absent when there are none. */
  attachments?: Attachment[];
  /** Successful-run details. Agent messages only; absent on errors and legacy data. */
  metadata?: AgentResponseMetadata;
  createdAt: number;
}

/** The output of a single backtest run, stored as the session's latest result. */
export interface StrategyResult {
  /** Portfolio value over time. Ascending by date. */
  equityCurve: EquityPoint[];
  /** Bar-close target weights over time. Ascending by date; absent on legacy results. */
  positions?: PositionsPoint[];
  /** Optional precomputed benchmark curve; normally null because the server fetches it. */
  benchmark?: EquityPoint[] | null;
  /** Comparable asset reassessed for this exact strategy version. */
  benchmarkTicker?: string;
  /** Short explanation of why that asset is an appropriate comparison. */
  benchmarkReason?: string;
  /** Whether the choice came from the agent, strategy inspection, or fallback. */
  benchmarkSource?: BenchmarkSelectionSource;
  /** Portfolio value at the end of the period. */
  finalValue: number;
  /** Portfolio value at the start (== session.startingCapital). */
  startingCapital: number;
  /** Total return, percent, one decimal of meaning. e.g. 206.4 or -23.8. */
  returnPct: number;
  /** The Python the agent wrote for this strategy (reused on date-only re-runs). */
  code?: string;
  /** When this result was produced. */
  ranAt: number;
  /** Wall-clock duration of the run that produced it, ms. */
  durationMs: number;
  /** Agent-inferred period; the run manager adopts it onto the session. */
  period?: Period;
}

/** Immutable, recoverable snapshot of one successfully completed backtest. */
export interface BacktestVersion {
  /** Session-scoped sequential id (`BT-001`, `BT-002`, ...). */
  id: string;
  /** Chat response that presents this version; absent only for malformed legacy runs. */
  messageId?: string;
  /** Version used as the starting point, if any. */
  basedOn: string | null;
  name: string;
  description: string;
  period: Period;
  startingCapital: number;
  /** Includes the exact equity curve and strategy.py source for restoration. */
  result: StrategyResult;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Strategy activation — scheduled buy/sell signal checks. Activating a strategy
// re-executes its SAVED code on a derived schedule (no LLM) and messages the
// user when the target portfolio changes. State lives on the session.
// ---------------------------------------------------------------------------

/** How often an activated strategy is re-checked for position changes. */
export type SignalCadence = 'hourly' | 'daily' | 'weekly' | 'monthly';

/** One target-weight move between the last two bars. `from`/`to` are weights. */
export interface SignalChange {
  ticker: string;
  /** BUY = target weight increased; SELL = decreased (to 0 = fully exited). */
  action: 'BUY' | 'SELL';
  from: number;
  to: number;
}

/** The outcome of one signal check that saw a new bar. */
export interface SignalUpdate {
  /** Bar date (`YYYY-MM-DD`) the signal is for. */
  date: string;
  /** Weight changes vs the previous bar; empty = HOLD. */
  changes: SignalChange[];
  /** Portfolio move on that bar, percent, or null when not computable. */
  dayChangePct: number | null;
  /** True when derived without a positions series (legacy saved code). */
  inferred: boolean;
  /** When the check ran (epoch ms). */
  checkedAt: number;
}

/** Live activation state for a strategy receiving scheduled signal checks. */
export interface StrategyActivation {
  /** E.164 number the signal messages go to. */
  phone: string;
  activatedAt: number;
  /** Check cadence derived from the strategy (asset class + rebalance frequency). */
  cadence: SignalCadence;
  /** Human sentence explaining the derived schedule; shown in UI + messages. */
  cadenceReason: string;
  /** When the next scheduled check fires (epoch ms). */
  nextCheckAt: number;
  /** When the last check ran (epoch ms), or null before the first. */
  lastCheckAt: number | null;
  /** Most recent check outcome that saw a new bar, or null. */
  lastSignal: SignalUpdate | null;
  /** Error from the most recent failed check, or null while healthy. */
  lastError: string | null;
}

/**
 * A strategy session. One per strategy; the list view is all sessions.
 * Persisted as JSON on disk keyed by id. "Persist results only": a session
 * left `running` when the server restarts is marked `failed` on boot (no reattach).
 */
export interface Session {
  id: string;
  /** Agent-generated short name (e.g. "Inverse Cramer"). '' until known. */
  name: string;
  /** Agent-generated one-line description for the list row. '' until known. */
  description: string;
  /** The original natural-language prompt. */
  prompt: string;
  period: Period;
  startingCapital: number;
  status: RunStatus;
  /** Latest completed result, or null if never finished a run. */
  result: StrategyResult | null;
  chat: ChatMessage[];
  /** Successful versions in ascending id order. Legacy files are hydrated on read. */
  backtests: BacktestVersion[];
  /** When data was last fetched/snapshotted for this session (epoch ms), or null. */
  dataSnapshotAt: number | null;
  /**
   * Unguessable token making this strategy readable at `/share/<token>` (the
   * tunnel-safe read-only page — see PROTOCOL.md §6). Absent/null = not shared.
   */
  shareToken?: string | null;
  /** Scheduled signal-check state. Absent/null = not activated. */
  activation?: StrategyActivation | null;
  /**
   * The model this strategy's LLM-backed runs use instead of the app-wide
   * setting (`AppSettings.model`). Absent/null = follow the setting.
   */
  model?: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Progress protocol
// ---------------------------------------------------------------------------
// A discriminated union used both (a) as the parsed form of what the agent
// writes to events.ndjson, and (b) as the SSE events streamed to the client.
// SSE encoding: `event: <type>\n` + `data: <JSON of the object>\n\n`.
// See PROTOCOL.md for the on-disk agent formats.
// ---------------------------------------------------------------------------

/** Whimsical single-word status shown next to the pulsing dot. */
export type StatusWord =
  | 'Tinkering…'
  | 'Sketching…'
  | 'Brewing…'
  | 'Crunching…'
  | 'Almost done…';

export interface StepEvent {
  type: 'step';
  /** Stable id so a later `active`→`done` update replaces the same row. */
  id: string;
  /** e.g. "Strategy written", "Prices fetched, 2016–2025". */
  label: string;
  state: 'active' | 'done';
}

export interface StatusEvent {
  type: 'status';
  /** One of the whimsical words; the header line in the Working view. */
  label: StatusWord;
  /** Elapsed ms since the run started (runner-authoritative). */
  elapsedMs: number;
}

export interface MetaEvent {
  type: 'meta';
  name: string;
  description: string;
}

export interface MessageEvent {
  type: 'message';
  role: 'agent' | 'system';
  text: string;
  /** Added by the run manager to the final successful agent response. */
  metadata?: AgentResponseMetadata;
}

/** Raw agent log line, surfaced only for debugging (not shown in chat). */
export interface LogEvent {
  type: 'log';
  text: string;
}

export interface ResultEvent {
  type: 'result';
  result: StrategyResult;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export interface DoneEvent {
  type: 'done';
}

export type ProgressEvent =
  | StepEvent
  | StatusEvent
  | MetaEvent
  | MessageEvent
  | LogEvent
  | ResultEvent
  | ErrorEvent
  | DoneEvent;

/** Events the AGENT is allowed to emit into events.ndjson (subset of the above). */
export type AgentEvent = StepEvent | StatusEvent | MetaEvent | MessageEvent | LogEvent;

/**
 * Snapshot sent to a client immediately on SSE connect so a reconnecting or
 * late-joining client can render current run state without missing history.
 */
export interface RunSnapshot {
  sessionId: string;
  status: RunStatus;
  /** Steps accumulated so far this run (latest state per id). */
  steps: StepEvent[];
  /** Current status word + elapsed, or null if not actively running. */
  status_line: { label: StatusWord; elapsedMs: number } | null;
  /** True while an agent run is actively in flight for this session. */
  active: boolean;
}

// ---------------------------------------------------------------------------
// API request bodies (client → server). Responses are Session / Session[].
// ---------------------------------------------------------------------------

/**
 * POST /api/sessions — create a strategy from a prompt and kick off run #1.
 *
 * Sent as JSON when there are no images. With images the endpoint takes
 * `multipart/form-data`: `prompt`, optional `start`/`end`/`startingCapital`,
 * and one `image` part per file (see PROTOCOL.md §6). Unlike a refinement, the
 * prompt is always required — an image alone can't say what period to test.
 */
export interface CreateSessionBody {
  prompt: string;
  /** Optional overrides; the agent may also infer these from the prompt. */
  period?: Partial<Period>;
  startingCapital?: number;
  /** Run this strategy on this model instead of the app-wide one (`Session.model`). */
  model?: string | null;
}

/**
 * POST /api/sessions/[id]/messages — a chat refinement (edits code + re-runs).
 *
 * Sent as JSON when there are no images. With images the same endpoint takes
 * `multipart/form-data`: a `text` field plus one `image` part per file (see
 * PROTOCOL.md §6). Text may be empty *only* when at least one image is present.
 */
export interface RefineBody {
  text: string;
}

/** Image types accepted for attachments — what Codex's `-i` can read. */
export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** Per-image size cap. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Per-message image count cap. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** POST /api/sessions/[id]/rerun — re-run reusing saved code. */
export interface RerunBody {
  period?: Partial<Period>;
  /** When true, discard the data snapshot and re-fetch fresh. */
  refreshData?: boolean;
}

/**
 * GET /api/sessions/[id]/benchmark — buy-and-hold curve for a comparable
 * equity over the session's period, scaled to the same starting capital.
 * Computed on demand (no agent run) so the Compare toggle is instant.
 */
export interface BenchmarkResponse {
  /** The symbol compared against, e.g. "QQQ". */
  ticker: string;
  /** Why this benchmark is appropriate for the selected strategy version. */
  reason: string;
  /** How the choice was made and revalidated. */
  source: BenchmarkSelectionSource;
  /** Version being compared; null only for an unversioned legacy result. */
  backtestId: string | null;
  /** Buy-and-hold portfolio value over time. Ascending by date. */
  curve: EquityPoint[];
  /** Value at the end of the period. */
  finalValue: number;
  /** Total buy-and-hold return, percent. */
  returnPct: number;
}

// ---------------------------------------------------------------------------
// Sharing (POST/DELETE /api/sessions/[id]/share). The token makes exactly one
// read-only page reachable through a tunnel; proxy.ts blocks everything
// else for tunnel traffic.
// ---------------------------------------------------------------------------

/** POST /api/sessions/[id]/share response. */
export interface ShareInfo {
  /** The share token; the page lives at `/share/<token>`. */
  token: string;
  /**
   * The full PUBLIC share link (`https://….trycloudflare.com/share/<token>`) —
   * the server starts the tunnel itself. Null only when cloudflared is missing.
   */
  url: string | null;
  /** Whether the `cloudflared` CLI is on this machine's PATH — the UI warns when not. */
  cloudflaredInstalled: boolean;
}

// ---------------------------------------------------------------------------
// Strategy activation API (POST/DELETE /api/sessions/[id]/activate,
// POST …/activate/check, GET /api/signals). The persisted state itself is
// `StrategyActivation` above; see PROTOCOL.md §8.
// ---------------------------------------------------------------------------

/**
 * POST /api/sessions/[id]/activate — start (or refresh) scheduled signal
 * checks. `phone` is E.164 (spaces/dashes tolerated); when omitted the server
 * falls back to HINDSIGHT_SIGNAL_PHONE. Returns the updated `Session`.
 */
export interface ActivateBody {
  phone?: string;
}

/** One activated strategy in the signals overview. */
export interface ActiveSignalEntry {
  sessionId: string;
  name: string;
  cadence: SignalCadence;
  /** Human sentence explaining the derived schedule. */
  cadenceReason: string;
  /** When the next scheduled check fires (epoch ms). */
  nextCheckAt: number;
  /** Most recent check outcome that saw a new bar, or null. */
  lastSignal: SignalUpdate | null;
}

/** GET /api/signals — activation defaults + every activated strategy. */
export interface SignalsOverview {
  /** HINDSIGHT_SIGNAL_PHONE when set and valid E.164, else null. Prefills the UI. */
  defaultPhone: string | null;
  /** The configured outbound provider: `imessage` (default), `signal`, `poke`, or `webhook`. */
  provider: string;
  active: ActiveSignalEntry[];
}

/** POST /api/sessions/[id]/activate/check — `update` is null when no new bar. */
export interface SignalCheckResponse {
  ok: true;
  update: SignalUpdate | null;
}

// ---------------------------------------------------------------------------
// Phone views (GET /api/mobile/strategies, GET /api/mobile/strategies/[id]).
// Display-ready and small: text is pre-formatted with lib/format and curves are
// pre-drawn SVG path data from lib/chart, so the phone app renders them as-is
// and agrees with the web UI on every figure. See server/routes/mobile.ts.
// ---------------------------------------------------------------------------

/** One strategy as a list row. */
export interface MobileStrategyRow {
  id: string;
  /** The agent's name for it; the clipped prompt until one exists. */
  name: string;
  description: string;
  status: RunStatus;
  /** False until a run has completed — the figures below are then empty. */
  hasResult: boolean;
  returnPct: number;
  /** `+206.4%`, or '' without a result. */
  returnText: string;
  /** `$30,642.05`, or '' without a result. */
  valueText: string;
  /** `2016–2025`. */
  periodText: string;
  /** Sparkline SVG path data in `sparkBox` coordinates, or ''. */
  spark: string;
  /** The sparkline's `viewBox`. */
  sparkBox: string;
  updatedAt: number;
}

/** One strategy in full, including the live run's progress while one is in flight. */
export interface MobileStrategy extends MobileStrategyRow {
  prompt: string;
  start: string;
  end: string;
  /** `+$20,642.05` — the gain or loss in dollars (the percent is `returnText`), or ''. */
  changeText: string;
  /** `2016–2025 · $10,000 start`. */
  metaText: string;
  /** Equity curve SVG path data (line, and the line closed into an area) in `chartBox` coordinates. */
  chartLine: string;
  chartArea: string;
  chartBox: string;
  /** Names the result on screen (`ranAt`), or '' without one: a new run is a new key. */
  resultKey: string;
  /** This strategy's own model id, or '' while it follows the app-wide setting. */
  model: string;
  /** The model its next run will use, by name (`GPT-5.6-Terra`); '' with the mock agent. */
  modelName: string;
  /** The agent that runs that model (`Codex`, `Claude Code`); '' with the mock agent. */
  agentName: string;
  /**
   * The chat. An agent message's `text` is Markdown (paragraphs, `- ` bullets,
   * `**bold**`); a user's or a system note's is plain. `note` is the small line
   * under a bubble (`BT-002 · 41 seconds`, `1 image`), or ''.
   */
  messages: { id: string; role: ChatRole; text: string; note: string }[];
  /** Steps of the run in flight; empty when idle. */
  steps: { id: string; label: string; done: boolean }[];
  /** The live status word (`Crunching…`), or '' when idle. */
  statusLabel: string;
  /** `0:23` elapsed in the live run, or '' when idle. */
  elapsedText: string;
}

/**
 * GET /api/mobile/settings — the phone's settings screen: the app-wide model
 * and effort, the choices Codex offers, and whether runs can start at all.
 */
export interface MobileSettings {
  /** `codex` for real runs; `mock` when the server simulates them (no model is called). */
  agent: 'codex' | 'mock';
  /** False when a run could not start (e.g. Codex is signed out); `status` says why. */
  ready: boolean;
  /** `Codex · signed in`, `Mock agent`, or the reason runs can't start. */
  status: string;
  /** Each agent and whether it can run: `{ name: 'Claude Code', status: 'Signed in', ready: true }`. */
  agents: { name: string; status: string; ready: boolean }[];
  model: string;
  /** The current model's display name; its id when Codex no longer offers it. */
  modelName: string;
  /** False when the current model is not among `models` (e.g. the account lost it). */
  modelOffered: boolean;
  effort: string;
  /** The choices, Codex's then Claude Code's; `group` is the agent's name (`Codex`). */
  models: { id: string; name: string; description: string; group: string }[];
  /** The efforts the current model accepts, as `{ id: 'xhigh', name: 'Extra high' }`. */
  efforts: { id: string; name: string }[];
}

/** One point of the phone's chart, as the readout under a finger shows it. */
export interface MobileChartPoint {
  /** `Mar 3, 2021`. */
  date: string;
  /** `$12,345.67` — the portfolio's value that day. */
  value: string;
  /** `+23.5%` — its change since the start. */
  change: string;
  up: boolean;
  /** The benchmark's value and change that day, or '' without a comparison. */
  bench: string;
  benchChange: string;
  /** Where the point sits from the top of the plot, 0 to 1: alone, and on the scale shared with the benchmark. */
  y: number;
  sharedY: number;
  /** The benchmark's point on the shared scale. */
  benchY: number;
}

/**
 * The equity curve for the phone: the paths to draw, with and without the
 * benchmark, and the points a finger scrubs across. Point `i` of `n` sits at
 * `i / (n - 1)` of the plot's width, as the paths are drawn.
 */
export interface MobileChart {
  id: string;
  /** The result this chart belongs to — `MobileStrategy.resultKey`. */
  key: string;
  box: string;
  /** The strategy alone, on its own scale. */
  line: string;
  area: string;
  /** Strategy and benchmark on one shared scale; '' when there is no comparison. */
  sharedLine: string;
  sharedArea: string;
  benchLine: string;
  /** The benchmark's symbol (`SPY`), or '' when the comparison could not be loaded. */
  ticker: string;
  /** `+182.1%` buy and hold over the same period. */
  benchReturnText: string;
  benchUp: boolean;
  /** Why this symbol is the comparison. */
  benchReason: string;
  /** `Beat SPY by 36.1 points`, or '' without a comparison. */
  edgeText: string;
  ahead: boolean;
  /** Why there is no comparison, in words, or ''. */
  benchError: string;
  points: MobileChartPoint[];
  /** Year labels along the x axis; `at` is 0 to 1 of the width. */
  ticks: { label: string; at: number }[];
  /** Figures for the detail list (`Annualized`, `Max drawdown`, …). */
  stats: { label: string; value: string }[];
}

// ---------------------------------------------------------------------------
// App settings (GET/PUT /api/settings). Persisted at `${data}/settings.json`;
// model + effort are forwarded to the agent container as HS_MODEL / HS_EFFORT
// on LLM-backed runs (initial/refine). See PROTOCOL.md §6.
// ---------------------------------------------------------------------------

/** Models offered in the settings dialog; the value goes to `codex exec -m`. */
export const CODEX_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
export type CodexModel = (typeof CODEX_MODELS)[number];

/** Reasoning-effort levels Codex accepts (`model_reasoning_effort`). */
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CodexEffort = (typeof CODEX_EFFORTS)[number];

export interface AppSettings {
  /**
   * Model for LLM-backed runs. A plain string (not the CodexModel union) so a
   * hand-edited settings.json or HINDSIGHT_CODEX_MODEL can name a model the
   * dialog doesn't offer; the PUT endpoint only accepts CODEX_MODELS values.
   */
  model: string;
  /** Reasoning effort for those runs. */
  effort: CodexEffort;
}

/** PUT /api/settings — partial update; the server merges, validates, persists. */
export type UpdateSettingsBody = Partial<AppSettings>;

/** The agents that can write a strategy: the Codex CLI or Claude Code. */
export type AgentProvider = 'codex' | 'claude';

/** One model an agent offers the signed-in account (GET /api/models). */
export interface CodexModelInfo {
  /** The agent that runs it. A Claude model's id starts with `claude`. */
  provider: AgentProvider;
  /** What goes to `codex exec -m` or `claude --model`, e.g. `gpt-5.6-terra`. */
  id: string;
  /** Codex's display name, e.g. `GPT-5.6-Terra`. */
  name: string;
  /** Codex's one-line description; may be ''. */
  description: string;
  /** Reasoning efforts this model accepts, weakest first. */
  efforts: CodexEffort[];
  defaultEffort: CodexEffort;
}

/**
 * GET /api/models — the models a run may use: Codex's, then Claude Code's when
 * it is signed in on this machine. `source` says where the Codex list came
 * from: `codex` (the CLI's live catalog), `cache` (the catalog the CLI last
 * saved under its home), or `builtin` (Codex could not be asked).
 */
export interface ModelsResponse {
  models: CodexModelInfo[];
  source: 'codex' | 'cache' | 'builtin';
}

/** One turn of a brainstorm: what the person said, or what the assistant answered. */
export interface IdeaMessage {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * POST /api/ideas — talk an idea through before any strategy exists. The whole
 * conversation is sent each time (the server keeps none); the last message is
 * the person's. `model` picks who answers; none follows the app-wide setting.
 */
export interface IdeasBody {
  messages: IdeaMessage[];
  model?: string | null;
}

/**
 * The assistant's answer: `reply` is what it says (Markdown), `strategy` the
 * idea so far as one plain-English prompt ready to backtest — '' while the
 * idea is still too vague to test.
 */
export interface IdeasReply {
  reply: string;
  strategy: string;
}

/** PUT /api/sessions/[id]/model — set or clear (`null`) a strategy's own model. */
export interface SessionModelBody {
  model: string | null;
}

// ---------------------------------------------------------------------------
// Agent health (GET /api/health). Tells the UI whether a run can be started
// at all — in 'codex' mode that requires Codex CLI credentials on the host.
// ---------------------------------------------------------------------------

/** Which backend selectRunner() picked for this process. */
export type AgentKind = 'mock' | 'codex';

export interface AgentHealth {
  agent: AgentKind;
  /** False only when the agent cannot run: codex mode without host credentials. */
  ready: boolean;
  /** One-line, user-facing explanation when `ready` is false. */
  reason: string | null;
  /** How to fix it, when `ready` is false (e.g. "Run `codex login`…"). */
  hint: string | null;
  /** Host path inspected for credentials (codex mode only). */
  codexHome: string | null;
  /** The agent the answer is about: the one that runs the model in question. */
  provider?: AgentProvider;
}
