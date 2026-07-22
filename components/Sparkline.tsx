'use client';

// List-row sparkline, 40px tall (viewBox 120×40, preserveAspectRatio="none", so
// any width just stretches the same curve). 1.8px stroke of the downsampled
// equity curve, green/red by sign, no fill.

import { SPARK, sparklinePath } from '@/lib/chart';
import { curveColor } from '@/lib/tokens';
import { useTheme } from '@/lib/client/useTheme';

export interface SparklineProps {
  values: number[];
  returnPct: number;
  /** CSS width; defaults to the design's 130px. Pass '100%' to fill a column. */
  width?: number | string;
}

export default function Sparkline({ values, returnPct, width = 130 }: SparklineProps) {
  const theme = useTheme();

  return (
    <svg
      width={width}
      height={40}
      viewBox={`0 0 ${SPARK.w} ${SPARK.h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Equity curve sparkline"
    >
      <path
        d={sparklinePath(values)}
        fill="none"
        stroke={curveColor(theme, returnPct)}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}
