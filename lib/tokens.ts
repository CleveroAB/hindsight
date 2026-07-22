// ============================================================================
// Design tokens (from the handoff README + Backtester.dc.html), as TS values.
// CSS custom properties in app/globals.css are the source of truth for styling;
// these mirror the color values for places that need them in JS — chiefly the
// SVG chart (stroke + gradient) which picks green/red by sign per theme.
// ============================================================================

export type ThemeName = 'light' | 'dark';

export const tokens = {
  light: {
    bg: '#F7F7F5',
    surface: '#FFFFFF',
    text: '#17191B',
    muted: '#A6A9A0',
    icon: '#70756F',
    faint: '#C0C2BA',
    borderInput: '#E2E2DC',
    borderChrome: '#E4E4DF',
    hairline: '#ECECE7',
    frameBorder: '#E4E4DF',
    greenText: '#159A5B',
    greenStroke: '#1FBE6E',
    red: '#D9494F',
    bubble: '#EFEFEA',
    chatText: '#17191B',
    benchmark: '#B9BCB3',
    primaryBg: '#17191B',
    primaryText: '#F7F7F5',
    // chart gradient top opacity for the area fill
    areaAlpha: 0.18,
    cardShadow: '0 10px 34px rgba(20,22,20,.07)',
    frameShadow: '0 12px 40px rgba(20,22,20,.07)',
  },
  dark: {
    bg: '#0C0D0C',
    surface: '#141614',
    text: '#F2F3EF',
    muted: '#6B7066',
    icon: '#8F948C',
    faint: '#4A4E46',
    borderInput: '#2A2C27',
    borderChrome: '#2A2C27',
    hairline: '#1C1E1B',
    frameBorder: '#232522',
    greenText: '#2FD67E',
    greenStroke: '#2FD67E',
    red: '#F2555B',
    bubble: '#1C1F1C',
    chatText: '#E4E6E0',
    benchmark: '#4A4E46',
    primaryBg: '#F2F3EF',
    primaryText: '#0C0D0C',
    areaAlpha: 0.22,
    cardShadow: '0 10px 34px rgba(0,0,0,.4)',
    frameShadow: '0 12px 40px rgba(20,22,20,.2)',
  },
} as const;

/** Chart stroke color for a given return sign + theme. */
export function curveColor(theme: ThemeName, returnPct: number): string {
  const t = tokens[theme];
  return returnPct >= 0 ? t.greenStroke : t.red;
}

/** rgba() of the curve color at the theme's area-fill top alpha. */
export function curveAreaColor(theme: ThemeName, returnPct: number): string {
  const t = tokens[theme];
  const hex = returnPct >= 0 ? t.greenStroke : t.red;
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${t.areaAlpha})`;
}

export function curveAreaColorTransparent(theme: ThemeName, returnPct: number): string {
  const t = tokens[theme];
  const hex = returnPct >= 0 ? t.greenStroke : t.red;
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},0)`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}
