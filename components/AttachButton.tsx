'use client';

// Paperclip button that opens a file picker for images. Owns its own hidden
// <input type="file">, so a composer just renders it and receives the files.

import { useRef } from 'react';
import { IMAGE_ACCEPT } from '@/lib/client/useImageDrafts';

export interface AttachButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** Button edge length; icon scales with it. */
  size?: number;
}

export default function AttachButton({ onFiles, disabled = false, size = 26 }: AttachButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const icon = Math.round(size * 0.58);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          // Reset so picking the same file twice in a row still fires change.
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach an image"
        title="Attach an image"
        style={{
          width: size,
          height: size,
          borderRadius: 7,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {/* Paperclip, drawn to match the ⓘ / theme-toggle icon weight. */}
        <svg width={icon} height={icon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M11.7 7.3 7.5 11.5a2.6 2.6 0 0 1-3.7-3.7l4.6-4.6a1.8 1.8 0 0 1 2.5 2.5l-4.5 4.6a.9.9 0 0 1-1.3-1.3l4.1-4.1"
            stroke="var(--icon)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </>
  );
}
