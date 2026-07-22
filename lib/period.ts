// ============================================================================
// parsePeriodFromPrompt — best-effort inference of a backtest window from the
// natural-language prompt. Pure and dependency-free (imports only the type).
//
// Detects an explicit year range and maps it to a full-calendar-year window:
//   start = `YYYY-01-01`, end = `YYYY-12-31`.
// Handles: "2016 to 2025", "2016-2025", "2016–2025" (en dash),
// "from 2016 to 2025", "between 2016 and 2025", and a single year
// ("in 2020" / "2020") which becomes that whole year. Two-digit years
// ("'16-'25") are intentionally ignored. Returns null when no plausible year
// is present. Only years 1970..2099 are accepted.
// ============================================================================

import type { Period } from '@/lib/types';

/** Matches a plausible 4-digit year (1970..2099) on word boundaries. */
const YEAR_RE = /\b(19[7-9]\d|20\d\d)\b/g;

/**
 * Infer a `Partial<Period>` from prompt-mentioned years, or null if none.
 * Both `start` and `end` are always set when a result is returned.
 */
export function parsePeriodFromPrompt(prompt: string): Partial<Period> | null {
  if (!prompt) return null;

  const years: number[] = [];
  YEAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = YEAR_RE.exec(prompt)) !== null) {
    const y = Number(m[1]);
    if (y >= 1970 && y <= 2099) years.push(y);
  }
  if (years.length === 0) return null;

  // One year -> that whole year. Multiple -> span the first and last mentioned
  // (covers "2016 to 2025", "2016-2025", "between 2016 and 2025", en dash, etc.).
  let startYear = years[0];
  let endYear = years.length === 1 ? years[0] : years[years.length - 1];
  if (startYear > endYear) {
    const tmp = startYear;
    startYear = endYear;
    endYear = tmp;
  }

  return {
    start: `${startYear}-01-01`,
    end: `${endYear}-12-31`,
  };
}
