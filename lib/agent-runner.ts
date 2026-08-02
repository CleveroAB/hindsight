// ============================================================================
// AgentRunner contract — the seam between the backend run manager and the
// agent layer (mock / codex+docker). The run manager prepares the working dir
// (writes params.json, clears data/ on refresh) and calls start(); the runner
// executes the backtest and streams ProgressEvents via onEvent, resolving
// `done` with the StrategyResult (or rejecting on failure/interrupt).
// See PROTOCOL.md §2. Shared file — no server-only imports.
// ============================================================================

import type { Attachment, CodexEffort, ProgressEvent, Session, StrategyResult } from './types';

export type RunKind = 'initial' | 'refine' | 'rerun' | 'refresh';

export interface RunInput {
  session: Session;
  /** Absolute host path to this session's working dir (mounted at /work). */
  workDir: string;
  kind: RunKind;
  /** The refinement text, present only for kind === 'refine'. May be '' if images carry the request. */
  message?: string;
  /**
   * Images sent with the refinement, living at `<workDir>/uploads/<name>`
   * (i.e. `/work/uploads/<name>` inside the container). Runners that can see
   * images should attach them to the model call; the mock ignores them.
   */
  attachments?: Attachment[];
  /** Exact model snapshot for an LLM-backed run; ignored by mock/rerun paths. */
  model?: string;
  /** Exact reasoning-effort snapshot paired with model. */
  effort?: CodexEffort;
  /** Runner emits parsed progress here as it works. */
  onEvent: (event: ProgressEvent) => void;
  /** Abort signal; when aborted, the runner must hard-kill its work. */
  signal: AbortSignal;
}

export interface RunHandle {
  /** Hard-kill the run (docker kill / process kill). Idempotent. */
  interrupt(): Promise<void>;
  /** Resolves with the result on success; rejects on failure or interrupt. */
  done: Promise<StrategyResult>;
}

export interface AgentRunner {
  /** The backend selects one runner for the process lifetime. */
  readonly kind: 'mock' | 'codex';
  start(input: RunInput): RunHandle;
}

/** The whimsical status words cycled in the Working view, in order. */
export const STATUS_WORDS = [
  'Tinkering…',
  'Sketching…',
  'Brewing…',
  'Crunching…',
  'Almost done…',
] as const;
