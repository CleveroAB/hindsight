'use client';

// ============================================================================
// useTheme — the current effective ThemeName ('light' | 'dark') as React state.
// Subscribes to both theme signals: the system preference (matchMedia) and the
// manual override (`data-theme` on <html>, stamped by lib/theme.ts). Charts use
// this so SVG strokes/gradients re-render on toggle.
// ============================================================================

import { useEffect, useState } from 'react';
import type { ThemeName } from '@/lib/tokens';
import {
  THEME_CHANGE_EVENT,
  applyTheme,
  effectiveTheme,
  storedOverride,
  storedPreference,
  type ThemePreference,
} from '@/lib/theme';

export function useTheme(): ThemeName {
  // SSR-safe default matches the CSS light default; synced on mount.
  const [theme, setTheme] = useState<ThemeName>('light');

  useEffect(() => {
    const update = () => setTheme(effectiveTheme());
    update();

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    return () => {
      mq.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);

  return theme;
}

/**
 * useThemePreference — the user's *choice* ('system' | 'light' | 'dark'), for
 * the theme menu's checkmark. Distinct from useTheme(), which reports what is
 * actually rendered. Starts at 'system' so SSR and the first client render
 * agree; the real value lands on mount.
 */
export function useThemePreference(): ThemePreference {
  const [preference, setPreference] = useState<ThemePreference>('system');

  useEffect(() => {
    const update = () => setPreference(storedPreference());
    update();

    window.addEventListener(THEME_CHANGE_EVENT, update);
    // Another tab changing the preference writes localStorage but fires no
    // in-page event; `storage` covers that. That tab also only stamped its OWN
    // <html data-theme>, so re-apply here to keep this tab's rendering (not
    // just the menu checkmark) in sync.
    const onStorage = () => {
      applyTheme(storedOverride());
      update();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, update);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return preference;
}
