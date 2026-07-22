'use client';

// Hero equity chart: full-width SVG (viewBox 800×300, rendered ~330px tall,
// preserveAspectRatio="none"). Filled gradient area under a 2.2px round-join
// stroke; green/red by sign of the total return. Optional dashed benchmark
// line behind the curve (the Compare toggle).
//
// When a benchmark is present both series are normalized against their SHARED
// min/max, so the two lines are readable against each other — whichever curve
// is higher really did have more money in it.

import { useId } from 'react';
import { HERO, boundsOf, equityAreaPath, equityLinePath, normalizeWith, pointsToPath } from '@/lib/chart';
import { curveAreaColor, curveAreaColorTransparent, curveColor } from '@/lib/tokens';
import { useTheme } from '@/lib/client/useTheme';

export interface EquityChartProps {
  values: number[];
  returnPct: number;
  benchmark?: number[] | null;
}

export default function EquityChart({ values, returnPct, benchmark }: EquityChartProps) {
  const theme = useTheme();
  const rawId = useId();
  const gradientId = `hs-hero-grad-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const hasBenchmark = !!benchmark && benchmark.length > 1;
  const bounds = hasBenchmark ? boundsOf(values, benchmark) : undefined;

  const linePath = equityLinePath(values, bounds);
  const areaPath = equityAreaPath(values, bounds);
  const stroke = curveColor(theme, returnPct);
  const areaTop = curveAreaColor(theme, returnPct);
  const areaBottom = curveAreaColorTransparent(theme, returnPct);

  const benchmarkPath =
    hasBenchmark && bounds
      ? pointsToPath(normalizeWith(benchmark, bounds), HERO.w, HERO.h, HERO.pad)
      : null;

  return (
    <svg
      width="100%"
      height={330}
      viewBox={`0 0 ${HERO.w} ${HERO.h}`}
      preserveAspectRatio="none"
      style={{ display: 'block' }}
      role="img"
      aria-label="Portfolio value over time"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={areaTop} />
          <stop offset="100%" stopColor={areaBottom} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      {benchmarkPath && (
        <path
          d={benchmarkPath}
          fill="none"
          stroke="var(--benchmark)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      )}
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={2.2} strokeLinejoin="round" />
    </svg>
  );
}
