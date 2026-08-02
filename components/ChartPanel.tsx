'use client';

// Right panel of the expanded view: big portfolio value + change line (with ⓘ
// tooltip) and the Compare toggle on the left, strategy name + meta line on the
// right; the hero equity chart anchored to the bottom of the flexible area with
// year ticks under it; then the Period row above a hairline. While a re-run is
// in flight the whole panel shimmers.
//
// Compare overlays the validated buy-and-hold benchmark saved/reassessed for
// the exact backtest version being presented. Price data comes from /benchmark
// without another agent run. The comparison starts enabled and can be hidden.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BacktestVersion, BenchmarkResponse, Period, Session, StrategyResult } from '@/lib/types';
import { alignToDates } from '@/lib/chart';
import { getBenchmark } from '@/lib/client/api';
import {
  formatChangeLine,
  formatDatePill,
  formatMetaLine,
  formatMoney,
  formatSignedPercent,
  yearOf,
} from '@/lib/format';
import ActivateControl from './ActivateControl';
import CompareToggle from './CompareToggle';
import EquityChart from './EquityChart';
import InfoTooltip from './InfoTooltip';
import PeriodRow from './PeriodRow';
import ShareControl from './ShareControl';
import StrategyExplanation from './StrategyExplanation';

export interface ChartPanelProps {
  session: Session;
  /** Older version selected via the chat's eye control; null = latest result. */
  viewedBacktest?: BacktestVersion | null;
  /** Return to presenting the latest result. */
  onShowLatest?: () => void;
  isRerunning: boolean;
  onRerun: (period: Period) => void;
  onRefresh: () => void;
  /** Push an activate/deactivate response Session into page state (chat note). */
  onSessionChange?: (session: Session) => void;
}

/**
 * Year tick labels for the x-axis, each with its horizontal position as a
 * fraction of the period (so labels sit under the dates they mark — laying
 * them out evenly would drift whenever the year gaps aren't uniform, e.g.
 * "…2022, 2024, 2025"). Interior ticks too close to either edge are dropped
 * rather than allowed to collide with the endpoint labels.
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
 * Annualized return in percent over the equity curve's actual traded span
 * (which can be shorter than the requested period). Null when the curve is too
 * short or the values can't support a geometric rate.
 */
function cagrPct(result: StrategyResult): number | null {
  const curve = result.equityCurve;
  if (curve.length < 2) return null;
  const years =
    (Date.parse(curve[curve.length - 1].date) - Date.parse(curve[0].date)) /
    (365.25 * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(years) || years <= 0) return null;
  if (result.startingCapital <= 0 || result.finalValue <= 0) return null;
  return ((result.finalValue / result.startingCapital) ** (1 / years) - 1) * 100;
}

export default function ChartPanel({
  session,
  viewedBacktest = null,
  onShowLatest,
  isRerunning,
  onRerun,
  onRefresh,
  onSessionChange,
}: ChartPanelProps) {
  // Everything displayed comes from the presented snapshot: an older version
  // selected via the chat's eye control, or the session's latest result.
  const result = viewedBacktest ? viewedBacktest.result : session.result;
  const period = viewedBacktest ? viewedBacktest.period : session.period;
  const name = viewedBacktest ? viewedBacktest.name : session.name;
  const description = viewedBacktest ? viewedBacktest.description : session.description;
  const presentedBacktest = useMemo(() => {
    if (viewedBacktest) return viewedBacktest;
    if (!session.result) return null;
    return (
      [...session.backtests].reverse().find((version) => version.result.ranAt === session.result?.ranAt) ??
      session.backtests[session.backtests.length - 1] ??
      null
    );
  }, [viewedBacktest, session.backtests, session.result]);
  const detailedExplanation = useMemo(() => {
    const exact = presentedBacktest?.messageId
      ? session.chat.find(
          (message) => message.id === presentedBacktest.messageId && message.role === 'agent',
        )
      : null;
    const tagged = presentedBacktest
      ? [...session.chat]
          .reverse()
          .find(
            (message) =>
              message.role === 'agent' && message.metadata?.backtestId === presentedBacktest.id,
          )
      : null;
    const latestDetailed = [...session.chat]
      .reverse()
      .find(
        (message) =>
          message.role === 'agent' &&
          message.text.trim().length > 0 &&
          !message.text.trimStart().toLowerCase().startsWith('agent exited'),
      );
    return exact?.text ?? tagged?.text ?? latestDetailed?.text ?? description ?? session.prompt;
  }, [presentedBacktest, session.chat, session.prompt, description]);

  const [compareOn, setCompareOn] = useState(true);
  const [benchmark, setBenchmark] = useState<BenchmarkResponse | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const { id: sessionId } = session;
  const { start: periodStart, end: periodEnd } = period;
  const ranAt = result?.ranAt ?? null;
  const comparisonBacktestId = presentedBacktest?.id;

  // A loaded benchmark belongs to one window + one run; anything that moves
  // either invalidates it (the fetch effect below then reloads it if compare is
  // still on).
  useEffect(() => {
    setBenchmark(null);
    setBenchmarkError(null);
  }, [sessionId, comparisonBacktestId, periodStart, periodEnd, ranAt]);

  useEffect(() => {
    if (!compareOn || benchmark || benchmarkError) return;
    let cancelled = false;
    setBenchmarkLoading(true);
    getBenchmark(sessionId, { backtestId: comparisonBacktestId })
      .then((data) => {
        if (!cancelled) setBenchmark(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBenchmarkError(err instanceof Error ? err.message : 'Comparison unavailable.');
        setCompareOn(false);
      })
      .finally(() => {
        if (!cancelled) setBenchmarkLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [compareOn, benchmark, benchmarkError, sessionId, comparisonBacktestId]);

  // Always discard the loaded comparison when toggling. Re-enabling then asks
  // the server for the benchmark selected from the latest strategy metadata.
  const toggleCompare = useCallback(() => {
    setBenchmark(null);
    setBenchmarkError(null);
    setCompareOn((on) => !on);
  }, []);

  const values = useMemo(
    () => (result ? result.equityCurve.map((p) => p.value) : []),
    [result],
  );
  // Resampled onto the strategy's own trading days so both lines share an
  // x-axis. The endpoint resolves the benchmark against this exact version.
  const benchmarkValues = useMemo(() => {
    if (!compareOn || !benchmark || !result) return null;
    return alignToDates(result.equityCurve.map((p) => p.date), benchmark.curve);
  }, [compareOn, benchmark, result]);
  const ticks = useMemo(() => yearTicks(period.start, period.end), [period.start, period.end]);

  const positive = (result?.returnPct ?? 0) >= 0;

  return (
    <div
      className={isRerunning ? 'hs-shimmer' : undefined}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '28px 32px',
        minWidth: 0,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
        <div>
          {result ? (
            <>
              <div
                className="num"
                style={{ fontSize: 38, fontWeight: 700, letterSpacing: '-0.03em', color: 'var(--text)' }}
              >
                {formatMoney(result.finalValue)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
                <div
                  className="num"
                  style={{
                    fontSize: 16,
                    fontWeight: 500,
                    color: positive ? 'var(--green-text)' : 'var(--red)',
                  }}
                >
                  {formatChangeLine(result.finalValue, result.startingCapital, result.returnPct)}
                </div>
                <InfoTooltip
                  start={result.startingCapital}
                  final={result.finalValue}
                  cagrPct={cagrPct(result)}
                />
              </div>
              <CompareToggle
                active={compareOn}
                loading={benchmarkLoading}
                ticker={benchmark?.ticker ?? null}
                returnPct={benchmark?.returnPct ?? null}
                reason={benchmark?.reason ?? null}
                error={benchmarkError}
                disabled={isRerunning}
                onToggle={toggleCompare}
              />
            </>
          ) : null}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
            {name || 'Untitled strategy'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            {formatMetaLine(
              period.start,
              period.end,
              viewedBacktest ? viewedBacktest.startingCapital : session.startingCapital,
            )}
          </div>
          {viewedBacktest && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              Viewing {viewedBacktest.id}
              {onShowLatest && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={onShowLatest}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: 'var(--text)',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textUnderlineOffset: 3,
                    }}
                  >
                    show latest
                  </button>
                </>
              )}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 8,
            }}
          >
            <StrategyExplanation
              name={name || 'Untitled strategy'}
              summary={description || 'No short strategy summary is available.'}
              details={detailedExplanation}
              snapshot={
                result
                  ? `${formatDatePill(period.start)} – ${formatDatePill(period.end)} · ${formatMoney(result.startingCapital)} → ${formatMoney(result.finalValue)} · ${formatSignedPercent(result.returnPct)} total return`
                  : `${formatDatePill(period.start)} – ${formatDatePill(period.end)}`
              }
              versionLabel={presentedBacktest?.id}
            />
            <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--faint)' }}>
              |
            </span>
            <ShareControl sessionId={session.id} shareToken={session.shareToken} />
            <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--faint)' }}>
              |
            </span>
            <ActivateControl
              sessionId={session.id}
              activation={session.activation}
              // Every activation route 409s while a run is in flight.
              disabled={isRerunning}
              onSessionChange={onSessionChange}
            />
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          marginTop: 12,
        }}
      >
        {result ? (
          <>
            <EquityChart
              values={values}
              returnPct={result.returnPct}
              benchmark={benchmarkValues}
            />
            <div
              className="num"
              style={{
                position: 'relative',
                height: 16,
                fontSize: 12,
                color: 'var(--faint)',
                marginTop: 8,
              }}
            >
              {ticks.map(({ year, frac }) => (
                <span
                  key={year}
                  style={{
                    position: 'absolute',
                    left: `${frac * 100}%`,
                    transform:
                      frac === 0 ? 'none' : frac === 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                  }}
                >
                  {year}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              color: 'var(--muted)',
            }}
          >
            No result yet.
          </div>
        )}
      </div>

      <PeriodRow
        period={session.period}
        isRerunning={isRerunning}
        onRerun={onRerun}
        onRefresh={onRefresh}
      />
    </div>
  );
}
