'use client';

// Right panel of the expanded view: big portfolio value + change line (with ⓘ
// tooltip) and the Compare toggle on the left, strategy name + meta line on the
// right; the hero equity chart anchored to the bottom of the flexible area with
// year ticks under it; then the Period row above a hairline. While a re-run is
// in flight the chart shimmers.
//
// Compare overlays a buy-and-hold curve for the strategy's own underlying (QQQ
// for a QQQ strategy), fetched on demand from /benchmark — no agent run. The
// dashed overlay is shown only while the toggle is on; it is dropped whenever
// the period or the result changes, then re-fetched for the new window.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BenchmarkResponse, Period, Session } from '@/lib/types';
import { alignToDates } from '@/lib/chart';
import { getBenchmark } from '@/lib/client/api';
import { formatChangeLine, formatMetaLine, formatMoney, yearOf } from '@/lib/format';
import CompareToggle from './CompareToggle';
import EquityChart from './EquityChart';
import InfoTooltip from './InfoTooltip';
import PeriodRow from './PeriodRow';
import ShareControl from './ShareControl';

export interface ChartPanelProps {
  session: Session;
  isRerunning: boolean;
  onRerun: (period: Period) => void;
  onRefresh: () => void;
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

export default function ChartPanel({ session, isRerunning, onRerun, onRefresh }: ChartPanelProps) {
  const result = session.result;

  const [compareOn, setCompareOn] = useState(false);
  const [benchmark, setBenchmark] = useState<BenchmarkResponse | null>(null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const { id: sessionId } = session;
  const { start: periodStart, end: periodEnd } = session.period;
  const ranAt = result?.ranAt ?? null;

  // A loaded benchmark belongs to one window + one run; anything that moves
  // either invalidates it (the fetch effect below then reloads it if compare is
  // still on).
  useEffect(() => {
    setBenchmark(null);
    setBenchmarkError(null);
  }, [sessionId, periodStart, periodEnd, ranAt]);

  useEffect(() => {
    if (!compareOn || benchmark || benchmarkError) return;
    let cancelled = false;
    setBenchmarkLoading(true);
    getBenchmark(sessionId)
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
  }, [compareOn, benchmark, benchmarkError, sessionId]);

  // Off → on always clears a previous failure, so the button doubles as retry.
  const toggleCompare = useCallback(() => {
    setCompareOn((on) => {
      if (!on) setBenchmarkError(null);
      return !on;
    });
  }, []);

  const values = useMemo(
    () => (result ? result.equityCurve.map((p) => p.value) : []),
    [result],
  );
  // Resampled onto the strategy's own trading days so both lines share an x-axis.
  const benchmarkValues = useMemo(() => {
    if (!compareOn || !benchmark || !result) return null;
    return alignToDates(result.equityCurve.map((p) => p.date), benchmark.curve);
  }, [compareOn, benchmark, result]);
  const ticks = useMemo(
    () => yearTicks(session.period.start, session.period.end),
    [session.period.start, session.period.end],
  );

  const positive = (result?.returnPct ?? 0) >= 0;

  return (
    <div
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
                <InfoTooltip start={result.startingCapital} final={result.finalValue} />
              </div>
              <CompareToggle
                active={compareOn}
                loading={benchmarkLoading}
                ticker={benchmark?.ticker ?? null}
                returnPct={benchmark?.returnPct ?? null}
                error={benchmarkError}
                disabled={isRerunning}
                onToggle={toggleCompare}
              />
            </>
          ) : null}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
            {session.name || 'Untitled strategy'}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
            {formatMetaLine(session.period.start, session.period.end, session.startingCapital)}
          </div>
          <ShareControl sessionId={session.id} shareToken={session.shareToken} />
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
            <div className={isRerunning ? 'hs-shimmer' : undefined}>
              <EquityChart
                values={values}
                returnPct={result.returnPct}
                benchmark={benchmarkValues}
              />
            </div>
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
