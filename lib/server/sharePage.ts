// ============================================================================
// Read-only share page renderer. Produces ONE self-contained HTML document —
// inline CSS, server-rendered SVG chart, zero JavaScript, no /_next assets or
// API calls — so proxy.ts can allowlist exactly one path for tunnel
// visitors and nothing else of the app needs to be reachable.
//
// Reuses the same chart math (lib/chart.ts) and formatting (lib/format.ts) as
// the live app, and mirrors the light/dark tokens from globals.css via
// prefers-color-scheme.
// ============================================================================

import type { Session } from '@/lib/types';
import { HERO, equityAreaPath, equityLinePath } from '@/lib/chart';
import { formatChangeLine, formatMetaLine, formatMoney, yearOf } from '@/lib/format';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Year tick labels with their horizontal position as a fraction of the period
 * (mirrors ChartPanel — evenly spaced labels would drift off the dates they
 * mark whenever the year gaps aren't uniform).
 */
function yearTicks(start: string, end: string): Array<{ year: number; frac: number }> {
  const a = yearOf(start);
  const b = yearOf(end);
  if (!Number.isFinite(a)) return Number.isFinite(b) ? [{ year: b, frac: 1 }] : [];
  if (!Number.isFinite(b) || b <= a) return [{ year: a, frac: 0 }];
  const t0 = Date.parse(start);
  const t1 = Date.parse(end);
  const step = Math.max(1, Math.ceil((b - a) / 6));
  const ticks: Array<{ year: number; frac: number }> = [{ year: a, frac: 0 }];
  for (let y = a + step; y < b; y += step) {
    const frac = (Date.parse(`${y}-01-01`) - t0) / (t1 - t0);
    if (frac > 0.06 && frac < 0.94) ticks.push({ year: y, frac });
  }
  ticks.push({ year: b, frac: 1 });
  return ticks;
}

/**
 * Shared skeleton: both the strategy page and the 404 use the same head/CSS so
 * a revoked link still looks like the product, not a bare error string.
 */
function document(title: string, positive: boolean, body: string): string {
  // Curve colors per theme × sign, as CSS vars so the SVG stays theme-aware.
  const curveLight = positive ? '#1FBE6E' : '#D9494F';
  const curveDark = positive ? '#2FD67E' : '#F2555B';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #f7f7f5; --surface: #ffffff; --text: #17191b; --muted: #a6a9a0;
    --faint: #c0c2ba; --hairline: #ecece7; --green-text: #159a5b;
    --red: #d9494f; --curve: ${curveLight}; --area-alpha: 0.18;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0d0c; --surface: #141614; --text: #f2f3ef; --muted: #6b7066;
      --faint: #4a4e46; --hairline: #1c1e1b; --green-text: #2fd67e;
      --red: #f2555b; --curve: ${curveDark}; --area-alpha: 0.22;
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 860px; margin: 0 auto; padding: 28px 28px 48px; }
  .wordmark { font-weight: 700; font-size: 16px; letter-spacing: -0.02em; }
  .top { display: flex; justify-content: space-between; align-items: center; height: 64px; }
  .badge { font-size: 12px; color: var(--muted); }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; margin-top: 26px; flex-wrap: wrap; }
  .num { font-variant-numeric: tabular-nums; }
  .value { font-size: 38px; font-weight: 700; letter-spacing: -0.03em; }
  .change { font-size: 16px; font-weight: 500; margin-top: 2px; }
  .pos { color: var(--green-text); } .neg { color: var(--red); }
  .name { font-size: 15px; font-weight: 600; text-align: right; }
  .meta { font-size: 13px; color: var(--muted); margin-top: 2px; text-align: right; }
  .desc { font-size: 13px; color: var(--muted); margin-top: 10px; max-width: 560px; line-height: 1.5; }
  .chart { margin-top: 28px; }
  .chart svg { display: block; width: 100%; height: 320px; }
  .ticks { position: relative; height: 16px; font-size: 12px; color: var(--faint); margin-top: 8px; }
  .ticks span { position: absolute; }
  details { margin-top: 32px; border-top: 1px solid var(--hairline); padding-top: 16px; }
  summary { font-size: 13px; color: var(--muted); cursor: pointer; }
  pre {
    margin-top: 12px; padding: 16px; background: var(--surface);
    border: 1px solid var(--hairline); border-radius: 12px;
    font-size: 12px; line-height: 1.55; overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  footer { margin-top: 36px; font-size: 12px; color: var(--faint); line-height: 1.5; }
  .empty { padding: 120px 0; text-align: center; font-size: 14px; color: var(--muted); }
</style>
</head>
<body>
<main>
  <div class="top"><span class="wordmark">Hindsight</span><span class="badge">Shared strategy · read-only</span></div>
  ${body}
</main>
</body>
</html>
`;
}

/** The hero chart as a static SVG string (area gradient + stroke). */
function chartSvg(values: number[]): string {
  const line = equityLinePath(values);
  const area = equityAreaPath(values);
  return `<svg viewBox="0 0 ${HERO.w} ${HERO.h}" preserveAspectRatio="none" role="img" aria-label="Portfolio value over time">
    <defs>
      <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--curve)" stop-opacity="var(--area-alpha)"/>
        <stop offset="100%" stop-color="var(--curve)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#grad)"/>
    <path d="${line}" fill="none" stroke="var(--curve)" stroke-width="2.2" stroke-linejoin="round"/>
  </svg>`;
}

/** Full share page for a session that has a result. */
export function renderSharePage(session: Session): string {
  const result = session.result;
  const name = session.name || 'Untitled strategy';
  if (!result) {
    return document(
      `Hindsight - ${name}`,
      true,
      `<div class="empty">This strategy has no completed backtest yet. Ask the person who shared it to try again later.</div>`,
    );
  }

  const positive = result.returnPct >= 0;
  const values = result.equityCurve.map((p) => p.value);
  const ticks = yearTicks(session.period.start, session.period.end);
  const ranAt = new Date(result.ranAt).toISOString().slice(0, 10);

  const body = `
  <div class="head">
    <div>
      <div class="value num">${escapeHtml(formatMoney(result.finalValue))}</div>
      <div class="change num ${positive ? 'pos' : 'neg'}">${escapeHtml(
        formatChangeLine(result.finalValue, result.startingCapital, result.returnPct),
      )}</div>
    </div>
    <div>
      <div class="name">${escapeHtml(name)}</div>
      <div class="meta">${escapeHtml(
        formatMetaLine(session.period.start, session.period.end, session.startingCapital),
      )}</div>
    </div>
  </div>
  ${session.description ? `<div class="desc">${escapeHtml(session.description)}</div>` : ''}
  <div class="chart">${chartSvg(values)}</div>
  <div class="ticks num">${ticks
    .map(({ year, frac }) => {
      const transform = frac === 0 ? 'none' : frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)';
      return `<span style="left:${(frac * 100).toFixed(2)}%;transform:${transform}">${year}</span>`;
    })
    .join('')}</div>
  ${
    result.code
      ? `<details><summary>strategy.py — the code behind this backtest</summary><pre>${escapeHtml(
          result.code,
        )}</pre></details>`
      : ''
  }
  <footer>Backtest simulation over ${escapeHtml(session.period.start)} – ${escapeHtml(
    session.period.end,
  )}, run ${ranAt}. Historical results; not investment advice.</footer>`;

  return document(`Hindsight - ${name}`, positive, body);
}

/** 404 body for unknown/revoked tokens — deliberately reveals nothing. */
export function renderShareNotFound(): string {
  return document(
    'Hindsight',
    true,
    `<div class="empty">This share link doesn’t exist or has been turned off.</div>`,
  );
}
