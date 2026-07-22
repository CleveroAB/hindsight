'use client';

// Full-screen viewer for an attached image. Opened by clicking a thumbnail
// anywhere images are shown (chat bubbles, the working view).
//
// Escape or a click on the backdrop closes it; ← / → step through the other
// images in the same message. Rendered in a portal above everything else so no
// ancestor's overflow or stacking context can clip it.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export interface LightboxImage {
  src: string;
  alt: string;
}

export interface ImageLightboxProps {
  images: LightboxImage[];
  /** Index of the image to show first. */
  startIndex: number;
  onClose: () => void;
}

export default function ImageLightbox({ images, startIndex, onClose }: ImageLightboxProps) {
  const [index, setIndex] = useState(startIndex);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const step = useCallback(
    (delta: number) => {
      setIndex((i) => (i + delta + images.length) % images.length);
    },
    [images.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop the strategy page's global Escape handler from also firing —
        // closing a picture must never interrupt a running backtest.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    };
    // Capture phase, for the same reason: run before the page-level listener.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, step]);

  if (!mounted || images.length === 0) return null;
  const current = images[Math.min(index, images.length - 1)];

  const navButton = (side: 'left' | 'right', delta: number, label: string, glyph: string) => (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        step(delta);
      }}
      style={{
        position: 'absolute',
        [side]: 16,
        top: '50%',
        transform: 'translateY(-50%)',
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.55)',
        color: '#FFFFFF',
        fontSize: 18,
        lineHeight: '40px',
        textAlign: 'center',
        backdropFilter: 'blur(4px)',
      }}
    >
      {glyph}
    </button>
  );

  return createPortal(
    <div
      className="hs-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label={current.alt}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 40,
        background: 'rgba(0,0,0,0.82)',
        cursor: 'zoom-out',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.src}
        alt={current.alt}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          borderRadius: 10,
          boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
          cursor: 'default',
        }}
      />

      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: 'absolute',
          top: 16,
          right: 16,
          width: 34,
          height: 34,
          borderRadius: '50%',
          background: 'rgba(0,0,0,0.55)',
          color: '#FFFFFF',
          fontSize: 15,
          lineHeight: '34px',
          textAlign: 'center',
          backdropFilter: 'blur(4px)',
        }}
      >
        ✕
      </button>

      {images.length > 1 && (
        <>
          {navButton('left', -1, 'Previous image', '‹')}
          {navButton('right', 1, 'Next image', '›')}
          <div
            className="num"
            style={{
              position: 'absolute',
              bottom: 20,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: 12,
              color: 'rgba(255,255,255,0.75)',
              background: 'rgba(0,0,0,0.55)',
              borderRadius: 'var(--r-round)',
              padding: '5px 12px',
              backdropFilter: 'blur(4px)',
            }}
          >
            {index + 1} / {images.length}
          </div>
        </>
      )}
    </div>,
    document.body,
  );
}
