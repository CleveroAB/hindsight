// ============================================================================
// scripts/seed.mjs — write three example DONE sessions into the data dir so the
// list view has content on first run. Plain Node ESM (no TS imports). Idempotent
// (fixed ids). Respects HINDSIGHT_DATA_DIR (default ./data).
//
//   node scripts/seed.mjs
// ============================================================================

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// --- paths (mirror lib/server/paths.ts, without importing TS) ---------------
function dataDir() {
  const env = process.env.HINDSIGHT_DATA_DIR;
  if (env && env.trim()) {
    return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  }
  return path.join(process.cwd(), 'data');
}
function sessionsDir() {
  return path.join(dataDir(), 'sessions');
}
function sessionFile(id) {
  return path.join(sessionsDir(), `${id}.json`);
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}
function isoOf(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// --- deterministic equity curve --------------------------------------------
// LCG (do NOT import lib/chart.ts). Builds an organic log-space walk that starts
// at $10,000 and lands exactly on `finalValue`, ~250 evenly-spaced points/year.
function lcg(seed) {
  let x = (seed >>> 0) || 1;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function buildCurve({ start, end, finalValue, seed, vol }) {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const days = Math.max(1, Math.round((endMs - startMs) / 86400000));
  const n = Math.max(2, Math.round((days / 365.25) * 250));

  const rand = lcg(seed);
  const w = new Array(n);
  w[0] = 0;
  for (let i = 1; i < n; i++) w[i] = w[i - 1] + (rand() - 0.5) * vol;
  const rawEnd = w[n - 1];
  const target = Math.log(finalValue / 10000);

  const curve = new Array(n);
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    // Detrend the raw walk's endpoint drift, add an exact linear trend to target.
    const g = w[i] - rawEnd * frac + target * frac;
    const value = Math.round(10000 * Math.exp(g) * 100) / 100;
    curve[i] = { date: isoOf(startMs + (endMs - startMs) * frac), value };
  }
  curve[0].value = 10000;
  curve[n - 1].value = finalValue;
  return curve;
}

// --- example strategy code (stored on result.code, reused on re-runs) -------
const INVERSE_CRAMER_CODE = `# Inverse Cramer — fade every on-air call, equal-weight, weekly rebalance.
import json
import backtrader as bt
from data import cramer_calls, adjusted_prices  # split/dividend-adjusted

with open("/work/params.json") as f:
    P = json.load(f)

START, END, CAPITAL = P["start"], P["end"], P["startingCapital"]
COST_BPS, SLIP_BPS, BORROW_FEE = 5, 5, 0.01  # 1%/yr borrow


def signals(week):
    # Short every buy call, buy every sell call; equal weight across the book.
    calls = cramer_calls(week)
    longs = [c.ticker for c in calls if c.action == "sell"]
    shorts = [c.ticker for c in calls if c.action == "buy"]
    return longs, shorts


def run():
    book = Portfolio(CAPITAL, cost_bps=COST_BPS, slip_bps=SLIP_BPS,
                     borrow_fee=BORROW_FEE)
    for week in weeks(START, END):
        longs, shorts = signals(week)
        # Signals at close act on the NEXT bar — no lookahead.
        book.rebalance_next_open(longs, shorts, adjusted_prices)
    return book.equity_curve()
`;

const GOLDEN_CROSS_CODE = `# Golden cross — long SPY when 50d SMA > 200d SMA, flat otherwise.
import json

with open("/work/params.json") as f:
    P = json.load(f)

START, END, CAPITAL = P["start"], P["end"], P["startingCapital"]
COST_BPS, SLIP_BPS = 5, 5


def run():
    px = total_return_prices("SPY", START, END)  # dividends reinvested
    sma50, sma200 = px.rolling(50).mean(), px.rolling(200).mean()
    long = sma50 > sma200               # signal at close ...
    target = long.shift(1).fillna(False)  # ... traded next open
    return backtest(px, target, CAPITAL, cost_bps=COST_BPS, slip_bps=SLIP_BPS)
`;

const MEME_MOMENTUM_CODE = `# Meme momentum — top-10 most-mentioned tickers, equal-weight, monthly.
import json

with open("/work/params.json") as f:
    P = json.load(f)

START, END, CAPITAL = P["start"], P["end"], P["startingCapital"]
COST_BPS, SLIP_BPS = 5, 5


def run():
    book = Portfolio(CAPITAL, cost_bps=COST_BPS, slip_bps=SLIP_BPS)
    for month in months(START, END):
        # Mention data is sparse before 2021; universe includes delisted names.
        names = top_mentions(month, k=10)
        book.rebalance_next_open(names, prices=total_return_prices)
    return book.equity_curve()
`;

// --- the three seed sessions ------------------------------------------------
const SESSIONS = [
  {
    id: 'seed-inverse-cramer',
    name: 'Inverse Cramer',
    description: 'Fade every Cramer call, weekly rebalance',
    prompt:
      'Short every stock Jim Cramer recommends, buy every one he says to sell. $10,000 start, 2016 to 2025.',
    period: { start: '2016-01-01', end: '2025-12-31' },
    finalValue: 30642.05,
    returnPct: 206.4,
    seed: 0x1a2b3c4d,
    vol: 0.011,
    durationMs: 41000,
    createdAt: Date.UTC(2025, 11, 20, 10, 0, 0),
    chat: [
      { role: 'user', text: 'Short every stock Jim Cramer recommends, buy every one he says to sell. $10,000 start, 2016 to 2025.' },
      { role: 'agent', text: 'Built it from Cramer’s public calls — each pick inverted, equal-weight, rebalanced weekly. Ten years, $10,000 in.' },
      { role: 'agent', text: 'Monthly lands at +182.1% — weekly wins. Kept weekly. Want to see both curves?' },
      { role: 'system', text: 'Backtest finished in 41s' },
    ],
    code: INVERSE_CRAMER_CODE,
  },
  {
    id: 'seed-golden-cross',
    name: 'Golden cross',
    description: 'SPY 50/200 SMA crossover, long only',
    prompt:
      'Go long SPY when the 50-day moving average crosses above the 200-day, exit on the death cross. Long only, $10,000 start, 2016 to 2025.',
    period: { start: '2016-01-01', end: '2025-12-31' },
    finalValue: 16420.11,
    returnPct: 64.2,
    seed: 0x51ce77a3,
    vol: 0.009,
    durationMs: 37000,
    createdAt: Date.UTC(2025, 11, 15, 10, 0, 0),
    chat: [
      { role: 'user', text: 'Go long SPY when the 50-day moving average crosses above the 200-day, exit on the death cross. Long only, $10,000 start, 2016 to 2025.' },
      { role: 'agent', text: 'Classic golden cross on SPY — 50/200-day simple moving averages, long only, no leverage. Total-return prices, 5 bps costs and slippage. Trades on the next open to avoid lookahead.' },
      { role: 'system', text: 'Backtest finished in 37s' },
    ],
    code: GOLDEN_CROSS_CODE,
  },
  {
    id: 'seed-meme-momentum',
    name: 'Meme momentum',
    description: 'Top-10 most-mentioned tickers, monthly',
    prompt:
      'Each month buy the ten most-mentioned tickers on retail forums, equal weight, hold a month, repeat. $10,000 start, 2021 to 2025.',
    period: { start: '2021-01-01', end: '2025-12-31' },
    finalValue: 7617.55,
    returnPct: -23.8,
    seed: 0x3d9f01bb,
    vol: 0.014,
    durationMs: 52000,
    createdAt: Date.UTC(2025, 11, 10, 10, 0, 0),
    chat: [
      { role: 'user', text: 'Each month buy the ten most-mentioned tickers on retail forums, equal weight, hold a month, repeat. $10,000 start, 2021 to 2025.' },
      { role: 'agent', text: 'Top-10 by monthly mention volume, equal-weight, rebalanced monthly. Mention data is sparse before 2021, so the run starts there, and I kept delisted names in the universe. Chasing the crowd cost you — down 23.8% over the run.' },
      { role: 'system', text: 'Backtest finished in 52s' },
    ],
    code: MEME_MOMENTUM_CODE,
  },
];

async function main() {
  await mkdir(sessionsDir(), { recursive: true });

  const written = [];
  for (const s of SESSIONS) {
    const equityCurve = buildCurve({
      start: s.period.start,
      end: s.period.end,
      finalValue: s.finalValue,
      seed: s.seed,
      vol: s.vol,
    });

    // Chat timestamps march forward from creation; result lands last.
    const chat = s.chat.map((m, i) => ({
      id: `${s.id}-m${i + 1}`,
      role: m.role,
      text: m.text,
      createdAt: s.createdAt + (i + 1) * 1000,
    }));
    const ranAt = s.createdAt + s.durationMs;

    const session = {
      id: s.id,
      name: s.name,
      description: s.description,
      prompt: s.prompt,
      period: s.period,
      startingCapital: 10000,
      status: 'done',
      result: {
        equityCurve,
        benchmark: null,
        finalValue: s.finalValue,
        startingCapital: 10000,
        returnPct: s.returnPct,
        // NOTE: deliberately no `code`. The snippets above are illustrative
        // pseudo-code, not runnable programs — persisting them as result.code
        // would let a "Run again"/"Refresh data" restore them to strategy.py and
        // execute something that exits 0 without ever writing result.json.
        // With no code, the run manager escalates a re-run to a full agent run
        // that rebuilds a real strategy from the prompt.
        ranAt,
        durationMs: s.durationMs,
      },
      chat,
      dataSnapshotAt: ranAt,
      createdAt: s.createdAt,
      updatedAt: ranAt,
    };

    await writeFile(sessionFile(s.id), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    written.push({ id: s.id, name: s.name, points: equityCurve.length });
  }

  console.log(`Seeded ${written.length} sessions into ${sessionsDir()}`);
  for (const w of written) {
    console.log(`  ✓ ${w.id.padEnd(20)} ${w.name.padEnd(16)} (${w.points} points)`);
  }
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
