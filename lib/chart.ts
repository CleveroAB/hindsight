// ============================================================================
// Chart math. Ports the reference generator from Backtester.dc.html (walk/toPath)
// and adds real-equity-curve → SVG-path conversion + downsampling.
//
// Hero chart:      viewBox 0 0 800 300, pad 8   (rendered at height 330, full width)
// Sparkline:       viewBox 0 0 120 40,  pad 3   (rendered at 130×40)
//
// Curves are normalized to their own min..max so the *shape* fills the vertical
// space (the absolute value is shown as the big number), exactly as the design does.
// ============================================================================

export const HERO = { w: 800, h: 300, pad: 8 } as const;
export const SPARK = { w: 120, h: 40, pad: 3 } as const;

/** Deterministic PRNG (LCG) matching the design's `rng`. */
export function rng(seed: number): () => number {
  let x = (seed * 2654435761) >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

/** Stable 32-bit hash of a string → usable as a walk seed. */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Seeded random walk normalized to [0,1] (min→0, max→1). Port of the design's
 * `walk`. Returns `len` points.
 */
export function seededWalk(seed: number, len: number, drift: number, vol: number): number[] {
  const r = rng(seed);
  let v = 0;
  const pts = [0];
  for (let i = 1; i < len; i++) {
    v += drift + (r() - 0.5) * vol;
    pts.push(v);
  }
  return normalize(pts);
}

/** Vertical range a series is drawn against. See `boundsOf`. */
export interface Bounds {
  min: number;
  max: number;
}

/** Normalize an arbitrary numeric series to [0,1] by its own min/max. */
export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  return normalizeWith(values, boundsOf(values));
}

/** Combined min/max across one or more series — a shared vertical scale. */
export function boundsOf(...series: number[][]): Bounds {
  const all = series.flat();
  if (all.length === 0) return { min: 0, max: 1 };
  return { min: Math.min(...all), max: Math.max(...all) };
}

/**
 * Normalize to [0,1] against an EXPLICIT range. Two series normalized against
 * their shared bounds stay comparable: the higher curve draws higher.
 */
export function normalizeWith(values: number[], bounds: Bounds): number[] {
  const span = bounds.max - bounds.min || 1;
  return values.map((p) => (p - bounds.min) / span);
}

/**
 * Resample `points` onto `dates` by forward-fill: each date takes the most
 * recent point at or before it (and the first point before that). Lets a
 * benchmark drawn from a different data source line up with the strategy's own
 * trading days instead of merely sharing the x-axis by index.
 */
export function alignToDates(
  dates: string[],
  points: { date: string; value: number }[],
): number[] {
  if (points.length === 0) return [];
  const out: number[] = [];
  let i = 0;
  let last = points[0].value;
  for (const date of dates) {
    while (i < points.length && points[i].date <= date) {
      last = points[i].value;
      i++;
    }
    out.push(last);
  }
  return out;
}

/**
 * Turn a normalized-[0,1] series into an SVG path string. Port of the design's
 * `toPath`. `scale` (default 1) compresses vertically (used for benchmark 0.42).
 */
export function pointsToPath(pts: number[], w: number, h: number, pad: number, scale = 1): string {
  if (pts.length === 0) return 'M0,0';
  if (pts.length === 1) {
    const y = (h - pad - pts[0] * scale * (h - 2 * pad)).toFixed(1);
    return `M0,${y} L${w},${y}`;
  }
  return pts
    .map((p, i) => {
      const x = ((i / (pts.length - 1)) * w).toFixed(1);
      const y = (h - pad - p * scale * (h - 2 * pad)).toFixed(1);
      return `${i ? 'L' : 'M'}${x},${y}`;
    })
    .join(' ');
}

/**
 * Hero line path from raw equity values. Normalized to its own min/max unless
 * `bounds` imposes a shared scale (used when a benchmark is overlaid).
 */
export function equityLinePath(values: number[], bounds?: Bounds): string {
  const pts = bounds ? normalizeWith(values, bounds) : normalize(values);
  return pointsToPath(pts, HERO.w, HERO.h, HERO.pad);
}

/** Hero area (filled) path: the line closed down to the baseline. */
export function equityAreaPath(values: number[], bounds?: Bounds): string {
  const line = equityLinePath(values, bounds);
  return `${line} L${HERO.w},${HERO.h} L0,${HERO.h} Z`;
}

/** Sparkline path (no fill) from raw equity values, downsampled to ~90 points. */
export function sparklinePath(values: number[], target = 90): string {
  const ds = downsample(values, target);
  return pointsToPath(normalize(ds), SPARK.w, SPARK.h, SPARK.pad);
}

/**
 * Downsample a series to at most `target` points, preserving endpoints and the
 * overall shape (evenly-spaced pick). Good enough for sparklines (~90 pts).
 */
export function downsample(values: number[], target: number): number[] {
  const n = values.length;
  if (n <= target) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.round((i / (target - 1)) * (n - 1));
    out.push(values[idx]);
  }
  return out;
}
