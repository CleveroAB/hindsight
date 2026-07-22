// ============================================================================
// Theme: system-preference default + manual override persisted in localStorage.
// The manual override, when set, stamps `data-theme` on <html> and wins over the
// media query (globals.css handles both signals). Client-only.
// ============================================================================

import type { ThemeName } from './tokens';

const KEY = 'hindsight-theme';

/**
 * What the user picked, as opposed to what's rendered: 'system' follows the OS,
 * 'light'/'dark' pin it. `effectiveTheme()` resolves this to a ThemeName.
 */
export type ThemePreference = ThemeName | 'system';

/**
 * Fired on <window> whenever the preference changes, so every mounted
 * useThemePreference() re-reads it. A MutationObserver on `data-theme` isn't
 * enough: switching between 'system' and the override that matches the current
 * system theme leaves the attribute's *value* looking equivalent, and clearing
 * an override doesn't tell a listener whether 'system' or a pin was chosen.
 */
export const THEME_CHANGE_EVENT = 'hindsight:theme-change';

/** The stored manual override, or null if following system. */
export function storedOverride(): ThemeName | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

/** The user's choice: 'system' when no override is stored. */
export function storedPreference(): ThemePreference {
  return storedOverride() ?? 'system';
}

/** Current system preference. */
export function systemTheme(): ThemeName {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Effective theme: override if set, else system. */
export function effectiveTheme(): ThemeName {
  return storedOverride() ?? systemTheme();
}

/** Apply a theme to <html> via data-theme (or clear it to follow system). */
export function applyTheme(theme: ThemeName | null) {
  if (typeof document === 'undefined') return;
  if (theme) document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

/** Persist a manual override (or clear it) and apply. */
export function setOverride(theme: ThemeName | null) {
  if (typeof window === 'undefined') return;
  if (theme) window.localStorage.setItem(KEY, theme);
  else window.localStorage.removeItem(KEY);
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/** Set the preference, mapping 'system' to "no override". */
export function setPreference(pref: ThemePreference) {
  setOverride(pref === 'system' ? null : pref);
}

/** Toggle to the opposite of whatever is currently effective, as a manual override. */
export function toggleTheme(): ThemeName {
  const next: ThemeName = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setOverride(next);
  return next;
}

/**
 * Inline script (stringified) to run before paint in <head>, avoiding a flash:
 * sets data-theme from the stored override immediately. System-followers get
 * their theme from the CSS media query, so we only stamp an explicit override.
 */
export const themeBootScript = `(function(){try{var v=localStorage.getItem('${KEY}');if(v==='light'||v==='dark'){document.documentElement.setAttribute('data-theme',v);}}catch(e){}})();`;
