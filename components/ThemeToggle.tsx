'use client';

// 32px circular theme control with the half-filled-circle icon, per the design.
//
// Two ways in, so the common case stays one tap:
//   • Click/tap  — flips to the opposite of what's *rendered* right now. From
//     'system' that means pinning the opposite of the system theme, which is
//     what "press it to switch" should do regardless of how you got here.
//   • Menu       — all three choices (System / Light / Dark). Opens on hover
//     (mouse), long-press (touch), or ArrowDown (keyboard), since touch devices
//     have no hover to reveal it with.

import { useCallback, useEffect, useRef, useState } from 'react';
import { setPreference, toggleTheme, type ThemePreference } from '@/lib/theme';
import { useTheme, useThemePreference } from '@/lib/client/useTheme';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Hover-open delay in, and grace period out (lets the pointer cross the gap). */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 220;
/** How long a touch must be held before the menu takes over from the tap. */
const LONG_PRESS_MS = 450;

function OptionIcon({ value }: { value: ThemePreference }) {
  const stroke = 'var(--icon)';
  if (value === 'light') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
        <circle cx="7" cy="7" r="3" fill="none" stroke={stroke} strokeWidth="1.3" />
        <g stroke={stroke} strokeWidth="1.3" strokeLinecap="round">
          <path d="M7 .9v1.4M7 11.7v1.4M.9 7h1.4M11.7 7h1.4M2.7 2.7l1 1M10.3 10.3l1 1M11.3 2.7l-1 1M3.7 10.3l-1 1" />
        </g>
      </svg>
    );
  }
  if (value === 'dark') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
        <path
          d="M11.6 8.6A5 5 0 0 1 5.4 2.4a5 5 0 1 0 6.2 6.2Z"
          fill="none"
          stroke={stroke}
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="1.1" y="2.4" width="11.8" height="7.6" rx="1.4" fill="none" stroke={stroke} strokeWidth="1.3" />
      <path d="M4.8 12.2h4.4" stroke={stroke} strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export default function ThemeToggle() {
  const theme = useTheme();
  const preference = useThemePreference();
  const [open, setOpen] = useState(false);

  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when a long-press opened the menu, so the click that follows the
  // release doesn't also toggle the theme.
  const swallowClick = useRef(false);

  const clearHoverTimer = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const clearPressTimer = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  useEffect(
    () => () => {
      clearHoverTimer();
      clearPressTimer();
    },
    [],
  );

  const close = useCallback((focusButton = false) => {
    clearHoverTimer();
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  // Dismiss on outside press, Escape, or scroll — the menu is absolutely
  // positioned, so a scrolled page would otherwise leave it stranded.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      // `contains` throws on a non-Node target (a synthetic event aimed at
      // window); treat anything that isn't a node as "outside".
      const target = e.target;
      if (!(target instanceof Node) || !wrapRef.current?.contains(target)) close();
    };
    // Capture phase + stopPropagation: Escape here means "close this menu",
    // and must never reach the page's run-interrupt listener.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    };
    const onScroll = () => close();
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [open, close]);

  const openMenu = (focusFirst = false) => {
    clearHoverTimer();
    setOpen(true);
    if (focusFirst) {
      // Wait for the menu to mount before moving focus into it.
      requestAnimationFrame(() => {
        const index = OPTIONS.findIndex((o) => o.value === preference);
        itemRefs.current[index === -1 ? 0 : index]?.focus();
      });
    }
  };

  const handleClick = () => {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    toggleTheme();
  };

  const choose = (value: ThemePreference) => {
    setPreference(value);
    close(true);
  };

  const onItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (index + delta + OPTIONS.length) % OPTIONS.length;
      itemRefs.current[next]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  };

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', flex: 'none' }}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        clearHoverTimer();
        hoverTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== 'mouse') return;
        clearHoverTimer();
        hoverTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Theme: ${preference}. Switch to ${theme === 'dark' ? 'light' : 'dark'}`}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleClick}
        onContextMenu={(e) => {
          // A long press on touch would otherwise raise the OS context menu on
          // top of ours.
          if (pressTimer.current || swallowClick.current) e.preventDefault();
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return;
          clearPressTimer();
          pressTimer.current = setTimeout(() => {
            pressTimer.current = null;
            swallowClick.current = true;
            openMenu();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clearPressTimer}
        onPointerCancel={clearPressTimer}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu(true);
          }
        }}
        style={{
          width: 32,
          height: 32,
          border: '1px solid var(--border-chrome)',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--surface)',
          flex: 'none',
          // Keeps the long press from selecting text or firing iOS's callout.
          touchAction: 'manipulation',
          WebkitUserSelect: 'none',
          userSelect: 'none',
          WebkitTouchCallout: 'none',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--icon)" strokeWidth="1.3" />
          <path d="M7 1.5 a5.5 5.5 0 0 1 0 11 Z" fill="var(--icon)" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Theme"
          className="hs-fade-in"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 172,
            padding: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border-chrome)',
            borderRadius: 12,
            boxShadow: 'var(--card-shadow)',
            zIndex: 40,
          }}
        >
          {OPTIONS.map((option, index) => {
            const active = option.value === preference;
            return (
              <button
                key={option.value}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => choose(option.value)}
                onKeyDown={(e) => onItemKeyDown(e, index)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  // 44px — the minimum comfortable touch target.
                  minHeight: 44,
                  padding: '0 10px',
                  borderRadius: 8,
                  border: 'none',
                  background: active ? 'var(--hairline)' : 'transparent',
                  color: 'var(--text)',
                  fontSize: 14,
                  textAlign: 'left',
                  cursor: 'pointer',
                  touchAction: 'manipulation',
                }}
              >
                <OptionIcon value={option.value} />
                <span style={{ flex: 1 }}>{option.label}</span>
                {active ? (
                  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
                    <path
                      d="M2.5 7.4 5.6 10.5 11.5 4"
                      fill="none"
                      stroke="var(--text)"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
