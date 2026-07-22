'use client';

// A small on-theme context menu, positioned at the pointer. Used by the
// strategy list rows in place of Chrome's own menu.
//
// It renders in a portal so no ancestor's overflow/stacking can clip it, flips
// itself back inside the viewport near an edge, and closes on the usual
// dismissals (outside pointer, Escape, scroll, resize, blur). Arrow keys /
// Home / End move between items so the menu is usable without a mouse.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** Renders in the red; use for destructive actions. */
  danger?: boolean;
  /** Draws a hairline above this item. */
  separatorBefore?: boolean;
}

export interface ContextMenuProps {
  /** Viewport coordinates of the originating right-click. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 190;
const EDGE_GAP = 8;

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Move focus into the menu once it exists. React's `autoFocus` only works on
  // form elements, and browsers ignore the attribute on dynamically inserted
  // nodes — without this, the keyboard handling below would never fire.
  useEffect(() => {
    if (mounted) menuRef.current?.focus();
  }, [mounted]);

  // Keep the whole menu on screen: measure once placed, then nudge/flip.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - EDGE_GAP;
    const maxTop = window.innerHeight - height - EDGE_GAP;
    setPos({
      left: Math.max(EDGE_GAP, Math.min(x, maxLeft)),
      top: Math.max(EDGE_GAP, Math.min(y, maxTop)),
    });
  }, [x, y]);

  // Dismissals. `capture` on pointerdown so the menu closes before the click
  // reaches whatever is underneath it.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('blur', onScroll);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('blur', onScroll);
    };
  }, [onClose]);

  const select = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      onClose();
      item.onSelect();
    },
    [items, onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // closing the menu must not also interrupt a run
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + items.length) % items.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(items.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (active >= 0) select(active);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Strategy actions"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="hs-fade-in"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        minWidth: MENU_WIDTH,
        padding: 5,
        background: 'var(--surface)',
        border: '1px solid var(--border-input)',
        borderRadius: 'var(--r-pill)',
        boxShadow: 'var(--card-shadow)',
        zIndex: 60,
        outline: 'none',
      }}
    >
      {items.map((item, i) => (
        <div key={item.label}>
          {item.separatorBefore && (
            <div style={{ height: 1, background: 'var(--hairline)', margin: '5px 6px' }} />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => select(i)}
            onMouseEnter={() => setActive(i)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '8px 11px',
              fontSize: 13,
              borderRadius: 7,
              color: item.danger ? 'var(--red)' : 'var(--text)',
              background: active === i ? 'rgba(127,127,127,0.10)' : 'transparent',
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
