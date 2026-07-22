// ============================================================================
// Agent-layer entry point. The backend imports exactly one thing from here —
// selectRunner() — to obtain the process-wide AgentRunner. Which runner is used
// is decided ONCE per process from HINDSIGHT_AGENT:
//   'codex' -> CodexRunner (real: Docker + `codex exec`)
//   anything else (default 'mock') -> MockRunner (in-process, no Docker/Codex)
// The choice is cached on globalThis so Next.js dev HMR doesn't churn it.
// ============================================================================

import type { AgentRunner } from '@/lib/agent-runner';
import { MockRunner } from './mockRunner';
import { CodexRunner } from './codexRunner';

const GLOBAL_KEY = '__hindsightAgentRunner__';

interface RunnerGlobal {
  [GLOBAL_KEY]?: AgentRunner;
}

/** The single AgentRunner for this process (cached). */
export function selectRunner(): AgentRunner {
  const g = globalThis as unknown as RunnerGlobal;
  if (g[GLOBAL_KEY]) return g[GLOBAL_KEY] as AgentRunner;

  const which = process.env.HINDSIGHT_AGENT === 'codex' ? 'codex' : 'mock';
  const runner: AgentRunner = which === 'codex' ? new CodexRunner() : new MockRunner();
  g[GLOBAL_KEY] = runner;
  return runner;
}

export { MockRunner, CodexRunner };
