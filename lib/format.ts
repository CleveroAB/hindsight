// ============================================================================
// Formatting helpers. All money/percent/date figures use these so the app is
// consistent and matches the design copy exactly. Callers must apply
// `font-variant-numeric: tabular-nums` in CSS (see .num / globals.css).
// ============================================================================

const MINUS = '−'; // U+2212 MINUS SIGN (design uses this, not hyphen)
const EN_DASH = '–'; // U+2013

const money0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const money2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `$30,642.05` */
export function formatMoney(value: number): string {
  return money2.format(value);
}

/** `$10,000` — whole dollars, used in the "$10,000 start" meta line. */
export function formatMoneyWhole(value: number): string {
  return money0.format(value);
}

/** `+$20,642.05` / `−$1,234.00` — signed change, 2 decimals, proper minus. */
export function formatSignedMoney(value: number): string {
  const sign = value < 0 ? MINUS : '+';
  return `${sign}${money2.format(Math.abs(value))}`;
}

/** `+206.4%` / `−23.8%` — signed, one decimal, proper minus sign. */
export function formatSignedPercent(pct: number): string {
  const sign = pct < 0 ? MINUS : '+';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** `$30,642.05` with `+$20,642.05 (+206.4%)` — returns the parenthetical piece. */
export function formatChangeLine(finalValue: number, startingCapital: number, returnPct: number): string {
  return `${formatSignedMoney(finalValue - startingCapital)} (${formatSignedPercent(returnPct)})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Jan 1, 2016` from an ISO `YYYY-MM-DD` (parsed as a plain calendar date, no TZ shift). */
export function formatDatePill(iso: string): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return iso;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Year of an ISO date. */
export function yearOf(iso: string): number {
  return parseInt(iso.slice(0, 4), 10);
}

/** `2016–2025` (en dash) from a period. Single year collapses to `2016`. */
export function formatYearRange(start: string, end: string): string {
  const a = yearOf(start);
  const b = yearOf(end);
  return a === b ? `${a}` : `${a}${EN_DASH}${b}`;
}

/** `2016–2025 · $10,000 start` — the expanded-view meta line. */
export function formatMetaLine(start: string, end: string, startingCapital: number): string {
  return `${formatYearRange(start, end)} · ${formatMoneyWhole(startingCapital)} start`;
}

/** `0:23` elapsed, m:ss from milliseconds. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

/** `Backtest finished in 41s` — from a duration in ms. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${s}s`;
}

export { MINUS, EN_DASH };
