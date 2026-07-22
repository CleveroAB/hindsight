// ============================================================================
// Benchmark curves — "how would simply holding the comparable equity have done?"
//
// This is deliberately OUTSIDE the agent layer: no container, no LLM, no run.
// The Compare toggle needs an answer in a few hundred ms, so we fetch daily
// adjusted closes straight from Yahoo's public chart endpoint and turn them
// into a buy-and-hold equity curve scaled to the session's starting capital.
//
// The symbol is inferred from the strategy itself (a QQQ golden-cross compares
// against QQQ, not SPY); the broad-market default only applies when the prompt
// names no tradable symbol.
// ============================================================================

import type { EquityPoint, Period, Session } from '@/lib/types';

/** Where we fall back when the strategy names no symbol of its own. */
export const DEFAULT_BENCHMARK = 'SPY';

/**
 * Symbols we recognise as benchmark-worthy on sight. Checked first so a prompt
 * mentioning both a broad ETF and a stray acronym still picks the ETF.
 */
const KNOWN_TICKERS = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'VT', 'EFA', 'EEM',
  'ARKK', 'TLT', 'IEF', 'AGG', 'GLD', 'SLV', 'XLK', 'XLF', 'XLE',
  'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'XLRE', 'SMH', 'SOXX',
];

/**
 * Uppercase words that look like tickers but aren't — indicators, jargon and
 * units that show up constantly in strategy prompts. Without this list a
 * "50-day SMA" strategy would benchmark itself against a symbol named SMA.
 */
const NOT_TICKERS = new Set([
  'SMA', 'EMA', 'WMA', 'RSI', 'MACD', 'ATR', 'ADX', 'BB', 'VWAP', 'OBV',
  'ETF', 'ETFS', 'USD', 'EUR', 'GBP', 'JPY', 'SEK', 'CAGR', 'YTD', 'MTD',
  'IPO', 'AI', 'ML', 'LLC', 'INC', 'CEO', 'CFO', 'EPS', 'PE', 'PEG', 'ROE',
  'ROI', 'EBIT', 'GDP', 'CPI', 'FED', 'FOMC', 'SEC', 'NYSE', 'NASDAQ',
  'AND', 'OR', 'THE', 'BUY', 'SELL', 'LONG', 'SHORT', 'HOLD', 'DAY', 'MAX',
  'MIN', 'AVG', 'STD', 'API', 'CSV', 'JSON', 'UTC', 'AM', 'PM', 'BPS',
]);

/** Yahoo-compatible symbol: letters/digits plus the `.`, `-`, `^` separators. */
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.^-]{0,9}$/;

/** True for a client-supplied `?ticker=` value we're willing to fetch. */
export function isValidTicker(ticker: string): boolean {
  return SYMBOL_RE.test(ticker);
}

/**
 * Pick the equity this strategy should be compared against: an explicitly named
 * symbol from the prompt/name if there is one, else the broad market.
 *
 * Case is the signal — people write tickers in caps ("long SPY", "on QQQ") and
 * prose in sentence case, so only all-caps runs are considered. Lowercasing the
 * haystack first would turn "Inverse Cramer" into a bid for a symbol INVERSE.
 */
export function inferBenchmarkTicker(session: Session): string {
  const haystack = `${session.name} ${session.prompt} ${session.description}`;
  const words: string[] = haystack.match(/\b[A-Z][A-Z0-9.-]*[A-Z0-9]\b/g) ?? [];

  for (const known of KNOWN_TICKERS) {
    if (words.includes(known)) return known;
  }
  for (const word of words) {
    if (word.length < 2 || NOT_TICKERS.has(word)) continue;
    if (SYMBOL_RE.test(word)) return word;
  }
  return DEFAULT_BENCHMARK;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

interface CacheEntry {
  curve: EquityPoint[];
  fetchedAt: number;
}

/** Price history for a closed historical window doesn't change; cache it a while. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;

// Survives dev HMR so a page reload doesn't re-hit Yahoo for the same window.
const g = globalThis as unknown as { __hindsightBenchmarkCache?: Map<string, CacheEntry> };
const cache: Map<string, CacheEntry> = (g.__hindsightBenchmarkCache ??= new Map());

function epochSeconds(iso: string, endOfDay: boolean): number {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000) + (endOfDay ? 86400 : 0);
}

function isoFromEpoch(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/**
 * Daily adjusted closes for `ticker` over `period`, as `[date, adjClose]` pairs.
 * Adjusted (total-return) closes keep the comparison honest against a strategy
 * that itself trades on adjusted prices.
 */
async function fetchAdjustedCloses(ticker: string, period: Period): Promise<EquityPoint[]> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${epochSeconds(period.start, false)}` +
    `&period2=${epochSeconds(period.end, true)}` +
    `&interval=1d&events=div%2Csplit`;

  const res = await fetch(url, {
    // Yahoo 404s requests without a browser-ish UA.
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Hindsight/0.1)' },
    cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Price data for ${ticker} is unavailable (HTTP ${res.status}).`);
  }

  const body = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: {
          adjclose?: Array<{ adjclose?: Array<number | null> }>;
          quote?: Array<{ close?: Array<number | null> }>;
        };
      }>;
      error?: { description?: string } | null;
    };
  };

  const description = body.chart?.error?.description;
  if (description) throw new Error(description);

  const result = body.chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const closes =
    result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];

  const points: EquityPoint[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const value = closes[i];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      points.push({ date: isoFromEpoch(stamps[i]), value });
    }
  }
  if (points.length < 2) {
    throw new Error(`No price history for ${ticker} in this period.`);
  }
  return points;
}

/** Drop the oldest entries once the cache outgrows its cap (insertion-ordered). */
function trimCache(): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Buy-and-hold curve for `ticker` over `period`, scaled so it starts at
 * `startingCapital` — directly comparable to a strategy's equity curve.
 * Throws with a human-readable message the route surfaces as `{ error }`.
 */
export async function benchmarkCurve(
  ticker: string,
  period: Period,
  startingCapital: number,
): Promise<EquityPoint[]> {
  const key = `${ticker}|${period.start}|${period.end}`;
  const hit = cache.get(key);
  const prices = hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS
    ? hit.curve
    : await fetchAdjustedCloses(ticker, period);

  if (!hit || Date.now() - hit.fetchedAt >= CACHE_TTL_MS) {
    cache.delete(key); // re-insert so the cache stays ordered oldest-first
    cache.set(key, { curve: prices, fetchedAt: Date.now() });
    trimCache();
  }

  const base = prices[0].value;
  return prices.map((p) => ({ date: p.date, value: (p.value / base) * startingCapital }));
}
