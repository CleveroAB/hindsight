// ============================================================================
// Benchmark curves — "how would simply holding the comparable equity have done?"
//
// This is deliberately OUTSIDE the agent layer: no container, no LLM, no run.
// The Compare toggle needs an answer in a few hundred ms, so we fetch daily
// adjusted closes straight from Yahoo's public chart endpoint and turn them
// into a buy-and-hold equity curve scaled to the session's starting capital.
//
// The symbol is inferred conservatively from the strategy itself (a QQQ
// golden-cross compares against QQQ; a big-tech basket uses QQQ). Incidental
// uppercase prose must never be treated as a ticker; ambiguous strategies use
// the broad market instead.
// ============================================================================

import type {
  BenchmarkSelectionSource,
  EquityPoint,
  Period,
  Session,
} from '@/lib/types';

/** Where we fall back when the strategy names no symbol of its own. */
export const DEFAULT_BENCHMARK = 'SPY';

/**
 * Symbols we recognise as benchmark-worthy on sight. Checked first so a prompt
 * mentioning both a broad ETF and a stray acronym still picks the ETF.
 */
const KNOWN_TICKERS = [
  'SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'VOO', 'VT', 'EFA', 'EEM',
  'ARKK', 'TLT', 'IEF', 'AGG', 'BND', 'LQD', 'HYG', 'GLD', 'SLV',
  'DBC', 'USO', 'VNQ', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP',
  'XLI', 'XLU', 'XLB', 'XLRE', 'SMH', 'SOXX',
];
const KNOWN_TICKER_SET = new Set(KNOWN_TICKERS);

const TECH_TICKERS = new Set([
  'AAPL', 'MSFT', 'AMZN', 'TSLA', 'META', 'GOOG', 'GOOGL', 'NVDA', 'AMD',
  'AVGO', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'INTC', 'CSCO', 'QCOM', 'TXN',
  'MU', 'AMAT', 'LRCX', 'KLAC', 'NOW', 'SHOP', 'UBER', 'PLTR',
]);
const SEMICONDUCTOR_TICKERS = new Set([
  'NVDA', 'AMD', 'AVGO', 'INTC', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX',
  'KLAC', 'ASML', 'TSM', 'ARM', 'MRVL', 'ADI', 'NXPI', 'MCHP',
]);
const BOND_TICKERS = new Set(['TLT', 'IEF', 'SHY', 'BIL', 'AGG', 'BND', 'LQD', 'HYG']);

/** Indicator/jargon tokens that must not be accepted as explicit symbols. */
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

export interface BenchmarkSelection {
  ticker: string;
  reason: string;
  source: BenchmarkSelectionSource;
}

function normalizeTicker(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ticker = value.trim().toUpperCase();
  return ticker && !NOT_TICKERS.has(ticker) && isValidTicker(ticker) ? ticker : null;
}

/** Symbols assigned to conventional strategy universe variables. */
export function strategyTickersFromCode(code: string | undefined): string[] {
  if (!code) return [];
  const symbols: string[] = [];
  const seen = new Set<string>();
  const assignments =
    /(?:^|\n)\s*(?:TICKERS?|SYMBOLS?|ASSETS?|UNIVERSE)\s*(?::[^=\n]+)?=\s*(\[[\s\S]*?\]|\([\s\S]*?\)|\{[\s\S]*?\}|["'][^"'\n]+["'])/g;

  for (const assignment of code.matchAll(assignments)) {
    const value = assignment[1];
    for (const literal of value.matchAll(/["']([A-Z0-9][A-Z0-9.^-]{0,9})["']/g)) {
      const ticker = normalizeTicker(literal[1]);
      if (ticker && !seen.has(ticker)) {
        seen.add(ticker);
        symbols.push(ticker);
      }
    }
  }
  return symbols;
}

/** A deliberately marked symbol in prose (`$AAPL` or `ticker AAPL`). */
function explicitTickerFromText(text: string): string | null {
  const patterns = [
    /\$([A-Z0-9][A-Z0-9.^-]{0,9})\b/g,
    /\b(?:ticker|symbol)\s*(?:is\s+|[=:]\s*)?([A-Z0-9][A-Z0-9.^-]{0,9})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const ticker = match[1];
      if (!NOT_TICKERS.has(ticker) && isValidTicker(ticker)) return ticker;
    }
  }
  return null;
}

function knownBenchmarkFromText(text: string): string | null {
  const words = text.match(/\b[A-Z][A-Z0-9.-]*[A-Z0-9]\b/g) ?? [];
  return words.find((word) => KNOWN_TICKER_SET.has(word)) ?? null;
}

function benchmarkForTheme(text: string): { ticker: string; label: string } | null {
  const themes: Array<[RegExp, string, string]> = [
    [/\b(?:semiconductor|chipmaker|chipmakers|chip\s+stocks?)\b/i, 'SOXX', 'semiconductor'],
    [/\b(?:big[\s-]?tech|technology|tech\s+(?:stock|stocks|sector)|nasdaq)\b/i, 'QQQ', 'technology'],
    [/\b(?:energy|oil|gas|petroleum)\b/i, 'XLE', 'energy'],
    [/\b(?:financials?|banks?|banking)\b/i, 'XLF', 'financial-sector'],
    [/\b(?:healthcare|health\s+care|biotech)\b/i, 'XLV', 'healthcare'],
    [/\b(?:utilities|utility\s+stocks?)\b/i, 'XLU', 'utilities-sector'],
    [/\b(?:real\s+estate|reits?)\b/i, 'XLRE', 'real-estate'],
    [/\b(?:industrial|industrials)\b/i, 'XLI', 'industrial-sector'],
    [/\b(?:materials|metals|mining)\b/i, 'XLB', 'materials-sector'],
    [/\b(?:treasur|fixed[\s-]?income|bond|bonds)\b/i, 'AGG', 'fixed-income'],
    [/\b(?:gold|precious\s+metals?)\b/i, 'GLD', 'gold'],
  ];
  for (const [pattern, ticker, label] of themes) {
    if (pattern.test(text)) return { ticker, label };
  }
  return null;
}

function ratioIn(symbols: string[], set: Set<string>): number {
  if (symbols.length === 0) return 0;
  return symbols.filter((ticker) => set.has(ticker)).length / symbols.length;
}

/** Server-side fallback derived from the exact accepted code and current meta. */
function deriveBenchmark(session: Session, symbols: string[]): BenchmarkSelection {
  if (symbols.length === 1) {
    return {
      ticker: symbols[0],
      reason: `${symbols[0]} buy-and-hold matches the strategy's single traded instrument.`,
      source: 'strategy',
    };
  }

  if (symbols.length > 1 && ratioIn(symbols, SEMICONDUCTOR_TICKERS) >= 0.6) {
    return {
      ticker: 'SOXX',
      reason: 'SOXX is a diversified semiconductor benchmark for this chip-focused universe.',
      source: 'strategy',
    };
  }

  if (symbols.length > 1 && ratioIn(symbols, TECH_TICKERS) >= 0.6) {
    return {
      ticker: 'QQQ',
      reason: 'QQQ is a liquid growth-technology benchmark for this multi-stock tech universe.',
      source: 'strategy',
    };
  }

  if (symbols.length > 1 && symbols.every((ticker) => BOND_TICKERS.has(ticker))) {
    return {
      ticker: 'AGG',
      reason: 'AGG is a broad investment-grade bond benchmark for this fixed-income universe.',
      source: 'strategy',
    };
  }

  const currentText = `${session.name} ${session.description}`;
  const namedBenchmark = knownBenchmarkFromText(currentText);
  if (namedBenchmark) {
    return {
      ticker: namedBenchmark,
      reason: `${namedBenchmark} is explicitly named by the accepted strategy.`,
      source: 'strategy',
    };
  }

  const currentTheme = benchmarkForTheme(currentText);
  if (currentTheme) {
    return {
      ticker: currentTheme.ticker,
      reason: `${currentTheme.ticker} is a liquid ${currentTheme.label} benchmark for the accepted strategy.`,
      source: 'strategy',
    };
  }

  // Once actual multi-asset code is available, never let an older opening
  // prompt override it. An unclassified current universe uses the broad market
  // unless the agent supplied a validated, more specific recommendation.
  if (symbols.length > 1) {
    return {
      ticker: DEFAULT_BENCHMARK,
      reason: 'SPY is the broad-market fallback for this multi-asset universe because no closer current proxy was validated.',
      source: 'fallback',
    };
  }

  const originalText = session.prompt;
  const originalBenchmark = knownBenchmarkFromText(originalText);
  if (originalBenchmark) {
    return {
      ticker: originalBenchmark,
      reason: `${originalBenchmark} is explicitly named by the strategy request.`,
      source: 'strategy',
    };
  }

  const explicitTicker = explicitTickerFromText(`${currentText} ${originalText}`);
  if (explicitTicker) {
    return {
      ticker: explicitTicker,
      reason: `${explicitTicker} is the explicitly identified strategy instrument.`,
      source: 'strategy',
    };
  }

  const originalTheme = benchmarkForTheme(originalText);
  if (originalTheme) {
    return {
      ticker: originalTheme.ticker,
      reason: `${originalTheme.ticker} is a liquid ${originalTheme.label} benchmark for this strategy.`,
      source: 'strategy',
    };
  }

  return {
    ticker: DEFAULT_BENCHMARK,
    reason:
      symbols.length > 1
        ? 'SPY is the broad-market fallback for a diversified universe without a closer validated proxy.'
        : 'SPY is the broad-market fallback because no more specific comparable asset was validated.',
    source: 'fallback',
  };
}

/**
 * Reassess the comparable asset for this exact accepted result. A Codex choice
 * is honored only when it includes a rationale and is either a known benchmark
 * proxy or an instrument found in the strategy. Otherwise code/meta inspection
 * derives a fresh selection, with SPY as the final conservative fallback.
 */
export function selectBenchmark(session: Session): BenchmarkSelection {
  const symbols = strategyTickersFromCode(session.result?.code);
  const recommended = normalizeTicker(session.result?.benchmarkTicker);
  const reason = session.result?.benchmarkReason?.trim().slice(0, 400) ?? '';
  const recommendationAllowed =
    session.result?.benchmarkSource === 'agent' &&
    recommended &&
    reason.length >= 8 &&
    (KNOWN_TICKER_SET.has(recommended) || symbols.includes(recommended));

  if (recommendationAllowed) {
    return {
      ticker: recommended,
      reason,
      source: 'agent',
    };
  }

  return deriveBenchmark(session, symbols);
}

/** Backward-compatible symbol-only helper. */
export function inferBenchmarkTicker(session: Session): string {
  return selectBenchmark(session).ticker;
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
const MAX_COVERAGE_GAP_MS = 14 * 24 * 60 * 60 * 1000;

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

  // Alignment forward-fills trading dates. Reject incomplete histories so a
  // recent IPO is not drawn as a flat investment for years before it existed.
  const requestedStart = Date.parse(`${period.start}T00:00:00Z`);
  const requestedEnd = Math.min(Date.parse(`${period.end}T00:00:00Z`), Date.now());
  const firstDate = Date.parse(`${prices[0].date}T00:00:00Z`);
  const lastDate = Date.parse(`${prices[prices.length - 1].date}T00:00:00Z`);
  if (
    !Number.isFinite(firstDate) ||
    !Number.isFinite(lastDate) ||
    firstDate - requestedStart > MAX_COVERAGE_GAP_MS ||
    requestedEnd - lastDate > MAX_COVERAGE_GAP_MS
  ) {
    throw new Error(`Price history for ${ticker} does not cover the requested period.`);
  }

  const base = prices[0].value;
  return prices.map((p) => ({ date: p.date, value: (p.value / base) * startingCapital }));
}
