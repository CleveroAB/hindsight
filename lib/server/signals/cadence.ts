// ============================================================================
// Signal-check cadence — WHEN an activated strategy should be re-checked,
// derived from the strategy itself: asset class (crypto trades 24/7; US
// equities have a closing bell) + rebalance frequency read from the prompt,
// description, and saved code. Pure date math over Intl.DateTimeFormat with
// America/New_York for equity sessions — no timezone dependency. Holidays are
// deliberately NOT modeled; a check that finds no new bar simply sends nothing.
// ============================================================================

import type { Session, SignalCadence } from '@/lib/types';
import { strategyTickersFromCode } from '@/lib/server/benchmark';

/** Market whose clock the scheduled checks follow. */
export type SignalAssetClass = 'us-equity' | 'crypto';

export interface CadenceDerivation {
  cadence: SignalCadence;
  /** Human sentence explaining the schedule; shown in the UI and in messages. */
  reason: string;
  assetClass: SignalAssetClass;
}

const ET = 'America/New_York';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Crypto pairs are `XXX-USD`-style symbols or bare well-known coin names. */
const CRYPTO_SUFFIX = /-(USD|USDT|EUR)$/;
const CRYPTO_COINS = new Set(['BTC', 'ETH', 'SOL', 'DOGE', 'ADA', 'XRP', 'LTC', 'BNB', 'AVAX', 'DOT']);
const CRYPTO_WORDS = /\b(crypto|cryptocurrenc\w*|bitcoin|btc|ethereum|eth|solana|altcoins?|stablecoins?|defi)\b/;

/**
 * Asset class for a session. Tickers come from the saved code's universe
 * variables and, when the result reports positions, the latest held book —
 * mock code names no literal tickers, so its `BTC-USD`-style position symbols
 * (and, as a last resort, prompt/description wording) still classify correctly.
 */
function deriveAssetClass(session: Session): SignalAssetClass {
  const symbols = strategyTickersFromCode(session.result?.code);
  const positions = session.result?.positions;
  const lastBar = positions && positions.length > 0 ? positions[positions.length - 1] : null;
  if (lastBar) symbols.push(...Object.keys(lastBar.weights));
  if (symbols.some((s) => CRYPTO_SUFFIX.test(s) || CRYPTO_COINS.has(s))) return 'crypto';
  const text = `${session.prompt}\n${session.description}`.toLowerCase();
  return CRYPTO_WORDS.test(text) ? 'crypto' : 'us-equity';
}

/**
 * Rebalance frequency read from prose + code. A generalized, server-side take
 * on `strategyCadence` in mockCurve.ts (whose display default is weekly):
 * intraday/hourly hints win, then weekly, then monthly/quarterly; checks
 * default to DAILY because daily bars are what a saved backtest re-run yields.
 */
function deriveFrequency(text: string): SignalCadence {
  if (/\b(hourly|intraday|scalp\w*|minute|min bars?|each hour|every hour)\b/.test(text)) return 'hourly';
  if (/\bweekly\b|\beach week\b|\bevery week\b/.test(text)) return 'weekly';
  if (/\bmonthly\b|\beach month\b|\bevery month\b|\bdca\b|dollar[- ]cost|\bquarter/.test(text)) return 'monthly';
  return 'daily';
}

const REASONS: Record<SignalAssetClass, Record<SignalCadence, string>> = {
  'us-equity': {
    hourly: 'US equities traded intraday — checks run hourly through US market hours (10:00–16:00 ET, weekdays)',
    daily: 'US equities on daily bars — checks run each trading day ~20 min after the US close',
    weekly: 'US equities on a weekly rebalance — checks run Fridays ~20 min after the US close',
    monthly: 'US equities on a monthly rebalance — checks run on the last weekday of each month, ~20 min after the US close',
  },
  crypto: {
    hourly: 'Crypto trades around the clock — checks run at the top of every hour',
    daily: 'Crypto on daily bars — checks run daily shortly after the 00:00 UTC bar close',
    weekly: 'Crypto on a weekly rebalance — checks run Mondays shortly after 00:00 UTC',
    monthly: 'Crypto on a monthly rebalance — checks run on the 1st of each month shortly after 00:00 UTC',
  },
};

/** Derive the check schedule (cadence + human reason + market clock) for a session. */
export function deriveCadence(session: Session): CadenceDerivation {
  const assetClass = deriveAssetClass(session);
  const text = `${session.prompt}\n${session.description}\n${session.result?.code ?? ''}`.toLowerCase();
  const cadence = deriveFrequency(text);
  return { cadence, reason: REASONS[assetClass][cadence], assetClass };
}

// ---------------------------------------------------------------------------
// Next-check time. All functions are pure: same (cadence, assetClass, after)
// in, same instant out. Equity slots are wall-clock times in America/New_York,
// resolved to UTC instants via Intl (DST-safe); crypto slots are plain UTC.
// ---------------------------------------------------------------------------

interface WallClock {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components of a UTC instant in `timeZone`. */
function wallClock(at: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Milliseconds `timeZone` is ahead of UTC at `at` (EDT ⇒ -4h). Whole minutes. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - at.getTime()) / 60_000) * 60_000;
}

/** UTC instant of the `y-m-d hh:mm` wall-clock time in `timeZone` (DST-safe). */
function zonedTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes converge for real-world zones (the second settles DST edges).
  let ts = naive - zoneOffsetMs(new Date(naive), timeZone);
  ts = naive - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** Weekday (0=Sun..6=Sat) of a calendar date — timezone-independent. */
function weekdayOf(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isWeekday(dow: number): boolean {
  return dow >= 1 && dow <= 5;
}

/** The calendar date `days` after `y-m-d` (normalized via Date.UTC). */
function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** First `hh:mm` ET instant strictly after `after` whose ET weekday passes `ok`. */
function nextEtSlot(after: Date, hh: number, mm: number, ok: (dow: number) => boolean): Date {
  const base = wallClock(after, ET);
  for (let offset = 0; offset < 15; offset++) {
    const { y, m, d } = addDays(base.year, base.month, base.day, offset);
    if (!ok(weekdayOf(y, m, d))) continue;
    const t = zonedTimeToUtc(y, m, d, hh, mm, ET);
    if (t.getTime() > after.getTime()) return t;
  }
  // Unreachable: any 15-day window contains matching weekdays.
  return new Date(after.getTime() + DAY_MS);
}

/** First `hh:mm` UTC instant strictly after `after` whose UTC date passes `ok`. */
function nextUtcSlot(
  after: Date,
  hh: number,
  mm: number,
  ok: (y: number, m: number, d: number) => boolean,
): Date {
  const y0 = after.getUTCFullYear();
  const m0 = after.getUTCMonth() + 1;
  const d0 = after.getUTCDate();
  for (let offset = 0; offset < 40; offset++) {
    const { y, m, d } = addDays(y0, m0, d0, offset);
    if (!ok(y, m, d)) continue;
    const t = new Date(Date.UTC(y, m - 1, d, hh, mm));
    if (t.getTime() > after.getTime()) return t;
  }
  return new Date(after.getTime() + DAY_MS);
}

/**
 * The next scheduled check instant strictly after `after`.
 *   us-equity — hourly: next whole hour within 10:00–16:00 ET on weekdays;
 *   daily: next weekday 16:20 ET; weekly: next Friday 16:20 ET; monthly: last
 *   weekday of the month 16:20 ET.
 *   crypto — hourly: next whole hour; daily: 00:20 UTC; weekly: Monday 00:20
 *   UTC; monthly: the 1st 00:20 UTC.
 */
export function nextCheckTime(cadence: SignalCadence, assetClass: SignalAssetClass, after: Date): Date {
  if (assetClass === 'crypto') {
    switch (cadence) {
      case 'hourly':
        return new Date((Math.floor(after.getTime() / HOUR_MS) + 1) * HOUR_MS);
      case 'daily':
        return nextUtcSlot(after, 0, 20, () => true);
      case 'weekly':
        return nextUtcSlot(after, 0, 20, (y, m, d) => weekdayOf(y, m, d) === 1);
      case 'monthly':
        return nextUtcSlot(after, 0, 20, (_y, _m, d) => d === 1);
    }
  }
  switch (cadence) {
    case 'hourly': {
      // Whole hours 10:00–16:00 ET on weekdays; walk forward to the first fit.
      const base = wallClock(after, ET);
      for (let offset = 0; offset < 15; offset++) {
        const { y, m, d } = addDays(base.year, base.month, base.day, offset);
        if (!isWeekday(weekdayOf(y, m, d))) continue;
        for (let hh = 10; hh <= 16; hh++) {
          const t = zonedTimeToUtc(y, m, d, hh, 0, ET);
          if (t.getTime() > after.getTime()) return t;
        }
      }
      return new Date(after.getTime() + DAY_MS); // unreachable
    }
    case 'daily':
      return nextEtSlot(after, 16, 20, isWeekday);
    case 'weekly':
      return nextEtSlot(after, 16, 20, (dow) => dow === 5);
    case 'monthly': {
      const base = wallClock(after, ET);
      for (let offset = 0; offset < 3; offset++) {
        const month0 = base.month - 1 + offset; // 0-based month, may overflow
        const y = base.year + Math.floor(month0 / 12);
        const m = (month0 % 12) + 1;
        // Walk back from the month's last calendar day to its last weekday.
        let d = new Date(Date.UTC(y, m, 0)).getUTCDate();
        while (!isWeekday(weekdayOf(y, m, d))) d -= 1;
        const t = zonedTimeToUtc(y, m, d, 16, 20, ET);
        if (t.getTime() > after.getTime()) return t;
      }
      return new Date(after.getTime() + DAY_MS); // unreachable
    }
  }
}
