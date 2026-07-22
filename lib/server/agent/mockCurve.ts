// ============================================================================
// Procedural mock equity-curve generator. Used by the in-process MockRunner so
// the app is fully demoable with no Docker/Codex. It is deterministic for a
// given (prompt, period) — same inputs always produce the same curve — while
// still looking organic (a drifted, seeded random walk anchored to a plausible
// accumulated return, not a straight line).
//
// It also derives a short strategy name + one-line description + a representative
// (HONEST, non-executing) Python snippet so re-runs/refines have real code to
// display and reuse. Node-only math (Date/Math) is fine here — this is not a
// workflow script.
// ============================================================================

import { hashSeed, rng, seededWalk } from '@/lib/chart';
import type { EquityPoint, Period } from '@/lib/types';

export interface MockCurve {
  equityCurve: EquityPoint[];
  finalValue: number;
  returnPct: number;
  code: string;
  name: string;
  description: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;
const TEN_YEARS_MS = 10 * YEAR_MS;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Keyword-driven "personality" for the curve. Bearish/short prompts get lower,
// noisier drift; steady/index prompts get modest positive drift with little
// noise; everything else is a mild positive default.
// ---------------------------------------------------------------------------

interface Personality {
  /** walk drift (shape only — the walk is normalized before use) */
  drift: number;
  /** walk volatility (shape only) */
  vol: number;
  /** how deep the organic wiggle rides around the trend (0..~0.4) */
  amplitude: number;
  /** base annualized return before per-prompt jitter */
  annualBase: number;
  /** width of the per-prompt jittered annualized-return band */
  annualSpan: number;
}

const BEARISH = /\b(short|shorts|shorting|inverse|fade|fading|meme|put|puts|bear|bearish|crash|decline|against|contrarian)\b/;
const STEADY = /\b(spy|s&p|sp500|sp 500|index|indices|dividend|dividends|dca|dollar[- ]cost|60\/40|treasur\w*|bond|bonds|buy[- ]and[- ]hold|long[- ]term|hold)\b/;

function personalityFor(prompt: string): Personality {
  const p = prompt.toLowerCase();
  if (BEARISH.test(p)) {
    return { drift: 0.15, vol: 3.0, amplitude: 0.3, annualBase: -0.08, annualSpan: 0.22 };
  }
  if (STEADY.test(p)) {
    // Enough wiggle to read as a real daily equity curve, while staying clearly
    // calmer than the default/bearish personas. Drift + annual band unchanged so
    // the anchored endpoints and returns are untouched.
    return { drift: 1.0, vol: 1.4, amplitude: 0.11, annualBase: 0.06, annualSpan: 0.08 };
  }
  return { drift: 1.0, vol: 1.6, amplitude: 0.16, annualBase: 0.03, annualSpan: 0.15 };
}

// ---------------------------------------------------------------------------
// Naming + description
// ---------------------------------------------------------------------------

const STOP = new Set([
  'a', 'an', 'the', 'every', 'all', 'each', 'my', 'me', 'i', 'that', 'which',
  'of', 'to', 'and', 'with', 'using', 'use', 'based', 'on', 'in', 'for', 'from',
  'by', 'strategy', 'backtest', 'test', 'when', 'then', 'do', 'does', 'go',
  'it', 'is', 'are', 'be', 'as', 'at', 'if', 'so', 'but', 'or', 'this', 'over',
  'about', 'into', 'stock', 'stocks', 'call', 'calls',
]);

const NAME_SPECIALS: Array<[RegExp, string]> = [
  // Specific STRATEGY patterns first, so a strategy that merely names an asset
  // (e.g. "Golden cross on SPY, 50/200 SMA") is named for the strategy, not the
  // asset/allocation patterns below.
  [/\bgolden cross\b/, 'Golden Cross'],
  [/\bmomentum\b/, 'Momentum Rotation'],
  [/\bmean[- ]reversion\b/, 'Mean Reversion'],
  [/\bpairs?\b/, 'Pairs Trade'],
  [/\bmoving average\b|\bsma\b|\bema\b/, 'Moving-Average Cross'],
  // Asset / allocation patterns.
  [/\b60\/40\b/, '60/40 Portfolio'],
  [/\bdca\b|\bdollar[- ]cost\b/, 'Dollar-Cost Average'],
  [/\bspy\b|\bs&p\b|\bsp ?500\b/, 'S&P Buy & Hold'],
];

function titleWord(w: string): string {
  if (!w) return w;
  return w[0].toUpperCase() + w.slice(1);
}

/** Short, plausible strategy name (<= 24 chars), title-cased key phrase. */
export function deriveName(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/\bcramer\b/.test(p)) {
    return /\b(inverse|fade|short|against|opposite|contrarian)\b/.test(p)
      ? 'Inverse Cramer'
      : 'Cramer Calls';
  }
  for (const [re, name] of NAME_SPECIALS) {
    if (re.test(p)) return name;
  }
  const words = p
    .replace(/[^a-z0-9&/ ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !STOP.has(w));
  if (words.length === 0) return 'Backtest';
  let picked = words.slice(0, 3).map(titleWord).join(' ');
  if (picked.length > 24) {
    picked = picked.slice(0, 24).replace(/\s\S*$/, '').trim();
  }
  return picked || 'Backtest';
}

/** Rebalance cadence inferred from the prompt (defaults to weekly). */
export function strategyCadence(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/\bdaily\b|\beach day\b|\bevery day\b/.test(p)) return 'daily';
  if (/\bmonthly\b|\bdca\b|dollar[- ]cost/.test(p)) return 'monthly';
  if (/\bquarter/.test(p)) return 'quarterly';
  if (/\bweekly\b|\beach week\b|\bevery week\b/.test(p)) return 'weekly';
  return 'weekly';
}

/** One-line description for the list row, quiet tone, cadence appended. */
export function deriveDescription(prompt: string, cadence: string): string {
  let snip = prompt.trim().replace(/\s+/g, ' ');
  if (snip.length > 52) {
    snip = snip.slice(0, 52).replace(/\s\S*$/, '').trim() + '…';
  }
  const mentionsCadence = /\b(daily|weekly|monthly|quarterly|rebalanc)/i.test(snip);
  return mentionsCadence ? snip : `${snip}, ${cadence} rebalance`;
}

// ---------------------------------------------------------------------------
// Representative (honest, non-executing) Python snippet for display + reuse.
// ---------------------------------------------------------------------------

function buildCode(name: string, description: string, cadence: string): string {
  const nameLit = JSON.stringify(name);
  const descLit = JSON.stringify(description);
  // Kept ASCII-safe and free of `${` so it survives as a plain Python program.
  return [
    'import json, os',
    'import numpy as np',
    'import pandas as pd',
    '',
    'WORK = "/work"',
    'PARAMS = json.load(open(os.path.join(WORK, "params.json")))',
    'START, END = PARAMS["start"], PARAMS["end"]',
    'CAPITAL = float(PARAMS["startingCapital"])',
    '',
    'COST_BPS = 5        # commission per trade (bps of traded notional)',
    'SLIP_BPS = 5        # slippage per trade (bps of traded notional)',
    'BORROW_APR = 0.01   # annual borrow fee charged on short exposure',
    '',
    'def emit(**e):',
    '    with open(os.path.join(WORK, "events.ndjson"), "a") as f:',
    '        f.write(json.dumps(e) + "\\n")',
    '',
    'def load_prices(symbols):',
    '    # split/dividend-adjusted (total-return) prices, cached under /work/data',
    '    cols = {}',
    '    for s in symbols:',
    '        p = os.path.join(WORK, "data", s + ".csv")',
    '        if os.path.exists(p):',
    '            cols[s] = pd.read_csv(p, index_col=0, parse_dates=True)["adj_close"]',
    '        else:',
    '            cols[s] = fetch_adjusted(s, START, END)  # fetch, then write cache',
    '    return pd.DataFrame(cols).loc[START:END].dropna(how="all")',
    '',
    'def backtest(px, weights):',
    '    # weights formed at each bar CLOSE trade on the NEXT bar (no lookahead)',
    '    pos = weights.shift(1).fillna(0.0)',
    '    ret = px.pct_change().fillna(0.0)',
    '    turnover = pos.diff().abs().fillna(pos.abs())',
    '    cost = turnover * (COST_BPS + SLIP_BPS) / 1e4',
    '    borrow = pos.clip(upper=0).abs() * (BORROW_APR / 252.0)  # short borrow fee',
    '    daily = (pos * ret).sum(axis=1) - cost.sum(axis=1) - borrow.sum(axis=1)',
    '    return CAPITAL * (1.0 + daily).cumprod()',
    '',
    'emit(type="status", label="Sketching…")',
    'px = load_prices(universe())              # ' + description,
    'emit(type="step", id="data", label=f"Prices fetched, {START[:4]}–{END[:4]}", state="done")',
    '',
    'emit(type="status", label="Crunching…")',
    'emit(type="step", id="backtest", label="Running the backtest", state="active")',
    'weights = ' + cadence + '_signals(px)      # rebalanced ' + cadence,
    'equity = backtest(px, weights)',
    'emit(type="step", id="backtest", label="Backtest complete", state="done")',
    '',
    'curve = [[d.strftime("%Y-%m-%d"), round(float(v), 2)] for d, v in equity.items()]',
    'final = float(equity.iloc[-1])',
    'result = {',
    '    "name": ' + nameLit + ',',
    '    "description": ' + descLit + ',',
    '    "startingCapital": CAPITAL,',
    '    "finalValue": round(final, 2),',
    '    "returnPct": round((final / CAPITAL - 1.0) * 100.0, 1),',
    '    "equityCurve": curve,',
    '    "benchmark": None,',
    '    "code": open(__file__).read(),',
    '    "period": {"start": START, "end": END},',
    '}',
    'json.dump(result, open(os.path.join(WORK, "result.json"), "w"))',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Date axis: ~252 points/year, evenly spaced calendar dates, strictly ascending.
// ---------------------------------------------------------------------------

function buildDates(startMs: number, endMs: number, n: number): string[] {
  const out: string[] = [];
  let prev = '';
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const ms = startMs + (endMs - startMs) * t;
    let iso = new Date(ms).toISOString().slice(0, 10);
    if (iso <= prev) {
      // Guard against duplicate calendar days on very short ranges: bump a day.
      const d = new Date(`${prev}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      iso = d.toISOString().slice(0, 10);
    }
    out.push(iso);
    prev = iso;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generateMockCurve(input: {
  prompt: string;
  period: Period;
  startingCapital: number;
}): MockCurve {
  const { prompt, period, startingCapital } = input;
  const capital = Number.isFinite(startingCapital) && startingCapital > 0 ? startingCapital : 10000;

  const seed = hashSeed(prompt + period.start + period.end);
  const persona = personalityFor(prompt);

  // Deterministic per-prompt jitter within the personality's annual band.
  const jitter = rng(hashSeed(`${prompt}|${period.start}|${period.end}|jitter`))();
  const annual = persona.annualBase + jitter * persona.annualSpan;

  // Calendar axis.
  const parsedStart = Date.parse(`${period.start}T00:00:00Z`);
  const parsedEnd = Date.parse(`${period.end}T00:00:00Z`);
  const startMs = Number.isFinite(parsedStart) ? parsedStart : Date.parse('2016-01-01T00:00:00Z');
  let endMs = Number.isFinite(parsedEnd) ? parsedEnd : startMs + TEN_YEARS_MS;
  if (endMs <= startMs) endMs = startMs + Math.round(YEAR_MS * 0.25);

  const years = Math.max((endMs - startMs) / YEAR_MS, 1 / 12);
  const n = clamp(Math.round(252 * years), 40, 4000);
  const dates = buildDates(startMs, endMs, n);

  // Organic wiggle: a normalized seeded walk with its endpoint trend removed,
  // then ridden on top of an exponential trend from capital -> target final.
  const shape = seededWalk(seed, n, persona.drift, persona.vol); // [0,1]
  const s0 = shape[0];
  const sN = shape[n - 1];
  const totalReturn = Math.pow(1 + annual, years) - 1;

  const equityCurve: EquityPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const detrended = shape[i] - (s0 + (sN - s0) * t); // 0 at both ends
    const trend = capital * Math.pow(1 + totalReturn, t); // capital -> target
    const value = trend * (1 + persona.amplitude * detrended);
    equityCurve[i] = { date: dates[i], value: round2(Math.max(value, capital * 0.02)) };
  }
  // Anchor exact endpoints (wiggle is already ~0 there, but be precise).
  equityCurve[0] = { date: dates[0], value: round2(capital) };

  const finalValue = equityCurve[n - 1].value;
  const returnPct = round1((finalValue / capital - 1) * 100);

  const name = deriveName(prompt);
  const cadence = strategyCadence(prompt);
  const description = deriveDescription(prompt, cadence);
  const code = buildCode(name, description, cadence);

  return { equityCurve, finalValue, returnPct, code, name, description };
}
