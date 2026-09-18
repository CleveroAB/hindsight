'use client';

// Horizontal placement for a small panel hanging below an inline control.
//
// The panel prefers to hang from the control's right edge (growing leftward),
// which is right for the desktop layout where the chart actions are
// right-aligned. On phones the same row is left-aligned, so that placement
// pushes the panel off the left side of the screen. Rather than special-case
// breakpoints, measure on open and slide the panel inward until it fits.

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface PopoverPlacementOptions {
  /** Width the panel would like; shrinks on narrow screens. */
  width: number;
  /** Minimum gap between the panel and either viewport edge. */
  gutter?: number;
}

export function usePopoverPlacement(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  { width: preferredWidth, gutter = 12 }: PopoverPlacementOptions,
): Pick<CSSProperties, 'left' | 'width'> {
  const [placement, setPlacement] = useState<{ left: number; width: number }>({
    left: 0,
    width: preferredWidth,
  });

  // Layout effect: runs before paint, so the first frame is already placed.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(preferredWidth, window.innerWidth - gutter * 2);
    const preferred = rect.right - width;
    const x = Math.min(Math.max(preferred, gutter), window.innerWidth - gutter - width);
    setPlacement({ left: x - rect.left, width });
  }, [open, anchorRef, preferredWidth, gutter]);

  return placement;
}
