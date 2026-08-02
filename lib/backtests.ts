// ============================================================================
// Backtest version ids and history helpers. Kept client-safe so the same id
// rules drive persistence, prompt resolution, and the copy control.
// ============================================================================

import type {
  AgentResponseMetadata,
  BacktestVersion,
  ChatMessage,
  Session,
  StrategyResult,
} from './types';

const ID_RE = /\bBT-(\d{1,6})\b/gi;
const COMPLETION_RE = /^Backtest finished in\s+.+$/i;

export function formatBacktestId(ordinal: number): string {
  return `BT-${String(Math.max(0, Math.trunc(ordinal))).padStart(3, '0')}`;
}

/** Canonical ids explicitly present in text, unique and in mention order. */
export function extractBacktestIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(ID_RE)) {
    const id = formatBacktestId(Number(match[1]));
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function findBacktest(session: Session, id: string): BacktestVersion | undefined {
  const canonical = extractBacktestIds(id)[0] ?? id.toUpperCase();
  return session.backtests.find((version) => version.id === canonical);
}

export function referencedBacktests(session: Session, text: string): BacktestVersion[] {
  return extractBacktestIds(text)
    .map((id) => findBacktest(session, id))
    .filter((version): version is BacktestVersion => Boolean(version));
}

export function nextBacktestId(session: Session): string {
  let max = 0;
  for (const version of session.backtests) {
    const match = /^BT-(\d+)$/.exec(version.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return formatBacktestId(max + 1);
}

export function latestBacktest(session: Session): BacktestVersion | undefined {
  return session.backtests[session.backtests.length - 1];
}

function cloneResult(result: StrategyResult): StrategyResult {
  return {
    ...result,
    equityCurve: result.equityCurve.map((point) => ({ ...point })),
    ...(result.positions
      ? {
          positions: result.positions.map((point) => ({
            date: point.date,
            weights: { ...point.weights },
          })),
        }
      : {}),
    benchmark: result.benchmark?.map((point) => ({ ...point })) ?? result.benchmark,
    ...(result.period ? { period: { ...result.period } } : {}),
  };
}

export function snapshotBacktest(input: {
  session: Session;
  id: string;
  result: StrategyResult;
  messageId?: string;
  basedOn: string | null;
}): BacktestVersion {
  const { session, id, result, messageId, basedOn } = input;
  return {
    id,
    ...(messageId ? { messageId } : {}),
    basedOn,
    name: session.name,
    description: session.description,
    period: { ...session.period },
    startingCapital: result.startingCapital,
    result: cloneResult(result),
    createdAt: result.ranAt,
  };
}

function completionCount(chat: ChatMessage[]): number {
  const legacy = chat.filter(
    (message) => message.role === 'system' && COMPLETION_RE.test(message.text.trim()),
  ).length;
  const structured = chat.filter(
    (message) => message.role === 'agent' && message.metadata && !message.metadata.backtestId,
  ).length;
  return legacy + structured;
}

function legacyResponse(chat: ChatMessage[]): ChatMessage | undefined {
  let completionIndex = -1;
  let structuredIndex = -1;
  for (let index = chat.length - 1; index >= 0; index -= 1) {
    const message = chat[index];
    if (
      structuredIndex < 0 &&
      message.role === 'agent' &&
      message.metadata &&
      !message.metadata.backtestId
    ) {
      structuredIndex = index;
    }
    if (
      completionIndex < 0 &&
      message.role === 'system' &&
      COMPLETION_RE.test(message.text.trim())
    ) {
      completionIndex = index;
    }
    if (completionIndex >= 0 && structuredIndex >= 0) break;
  }
  if (structuredIndex > completionIndex) return chat[structuredIndex];
  const start = completionIndex >= 0 ? completionIndex - 1 : chat.length - 1;
  for (let index = start; index >= 0; index -= 1) {
    if (chat[index].role === 'agent') return chat[index];
  }
  return undefined;
}

function legacyMetadata(
  result: StrategyResult,
  backtestId: string,
  existing?: AgentResponseMetadata,
): AgentResponseMetadata {
  return {
    durationMs: existing?.durationMs ?? result.durationMs,
    model: existing?.model ?? null,
    effort: existing?.effort ?? null,
    mode: existing?.mode ?? 'legacy',
    backtestId,
  };
}

/**
 * Hydrate old session JSON into the versioned contract without inventing
 * unavailable historical code. Only its currently accepted result is
 * recoverable; its id keeps the original completion ordinal (for example a
 * four-run legacy chat starts with BT-004, then the next run is BT-005).
 *
 * This mutates the freshly parsed session. It is persisted on the next normal
 * save, while read-only GETs can expose the deterministic migration immediately.
 */
export function ensureBacktestHistory(session: Session): Session {
  session.backtests ??= [];

  if (session.backtests.length === 0 && session.result) {
    const id = formatBacktestId(Math.max(1, completionCount(session.chat)));
    const response = legacyResponse(session.chat);
    if (response) response.metadata = legacyMetadata(session.result, id, response.metadata);
    session.backtests.push(
      snapshotBacktest({
        session,
        id,
        result: session.result,
        messageId: response?.id,
        basedOn: null,
      }),
    );
  }

  // Repair a partially migrated file whose snapshots exist but whose response
  // metadata predates backtestId.
  const messages = new Map(session.chat.map((message) => [message.id, message]));
  for (const version of session.backtests) {
    if (!version.messageId) continue;
    const response = messages.get(version.messageId);
    if (!response || response.role !== 'agent') continue;
    if (response.metadata?.backtestId === version.id) continue;
    response.metadata = legacyMetadata(version.result, version.id, response.metadata);
  }

  return session;
}
