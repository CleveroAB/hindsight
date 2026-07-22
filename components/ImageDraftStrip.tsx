'use client';

// The row of thumbnails for images picked but not yet sent, each with a small
// remove button. Shared by both composers so an attachment looks the same
// wherever you added it.

import { useState } from 'react';
import type { ImageDraft } from '@/lib/client/useImageDrafts';
import ImageLightbox from './ImageLightbox';

export interface ImageDraftStripProps {
  drafts: ImageDraft[];
  onRemove: (id: string) => void;
  /** Thumbnail edge length; the empty-state composer runs a little larger. */
  size?: number;
}

export default function ImageDraftStrip({ drafts, onRemove, size = 56 }: ImageDraftStripProps) {
  const [openAt, setOpenAt] = useState<number | null>(null);
  if (drafts.length === 0) return null;

  const images = drafts.map((d) => ({ url: d.url, alt: d.file.name }));

  return (
    <div className="hs-fade-in" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {drafts.map((draft, i) => (
        <div key={draft.id} style={{ position: 'relative', lineHeight: 0 }}>
          <button
            type="button"
            onClick={() => setOpenAt(i)}
            aria-label={`View ${draft.file.name}`}
            title={draft.file.name}
            style={{ lineHeight: 0, borderRadius: 8, cursor: 'zoom-in' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={draft.url}
              alt={draft.file.name}
              style={{
                width: size,
                height: size,
                objectFit: 'cover',
                borderRadius: 8,
                border: '1px solid var(--border-input)',
                display: 'block',
              }}
            />
          </button>
          <button
            type="button"
            onClick={() => onRemove(draft.id)}
            aria-label={`Remove ${draft.file.name}`}
            title="Remove"
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--primary-bg)',
              color: 'var(--primary-text)',
              fontSize: 11,
              lineHeight: '18px',
              textAlign: 'center',
              boxShadow: 'var(--card-shadow)',
            }}
          >
            ✕
          </button>
        </div>
      ))}

      {openAt !== null && (
        <ImageLightbox
          images={images.map((im) => ({ src: im.url, alt: im.alt }))}
          startIndex={openAt}
          onClose={() => setOpenAt(null)}
        />
      )}
    </div>
  );
}
