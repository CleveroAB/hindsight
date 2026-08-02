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
  /** Distinguishes non-LLM runs so the UI can explain a null model accurately. */
  mode: 'codex' | 'mock' | 'saved-code' | 'legacy';
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
  /** The configured outbound provider: `imessage` (default), `poke`, or `webhook`. */
  provider: string;
  active: ActiveSignalEntry[];
}

/** POST /api/sessions/[id]/activate/check — `update` is null when no new bar. */
export interface SignalCheckResponse {
  ok: true;
  update: SignalUpdate | null;
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
}
