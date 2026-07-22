'use client';

// Thumbnails for images attached to a message, click-to-enlarge. Used by chat
// bubbles and by the working view's prompt card, so an attachment looks and
// behaves the same wherever it appears.

import { useState } from 'react';
import type { Attachment } from '@/lib/types';
import { attachmentUrl } from '@/lib/client/api';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';

export interface AttachmentGalleryProps {
  /** Owning session — needed to build attachment URLs. */
  sessionId: string;
  /** Persisted attachments; resolved to URLs through the API. */
  attachments?: Attachment[];
  /**
   * Local object URLs for an optimistic bubble whose images aren't on the
   * server yet. Ignored when `attachments` is present.
   */
  previews?: string[];
  /** 'fill' stretches to the container (chat); 'fixed' uses a set thumb size. */
  layout?: 'fill' | 'fixed';
  /** Thumbnail edge length for the 'fixed' layout. */
  size?: number;
  /** Cap on thumbnail height for the 'fill' layout. */
  maxHeight?: number;
}

export default function AttachmentGallery({
  sessionId,
  attachments,
  previews,
  layout = 'fill',
  size = 68,
  maxHeight = 200,
}: AttachmentGalleryProps) {
  const [openAt, setOpenAt] = useState<number | null>(null);

  const images: LightboxImage[] = attachments?.length
    ? attachments.map((a) => ({ src: attachmentUrl(sessionId, a.name), alt: a.originalName }))
    : (previews ?? []).map((url) => ({ src: url, alt: 'Attached image' }));

  if (images.length === 0) return null;

  const thumbStyle =
    layout === 'fixed'
      ? { width: size, height: size, objectFit: 'cover' as const }
      : {
          maxWidth: images.length > 1 ? 'calc(50% - 3px)' : '100%',
          maxHeight,
          objectFit: 'cover' as const,
        };

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {images.map((img, i) => (
          <button
            key={img.src}
            type="button"
            onClick={() => setOpenAt(i)}
            aria-label={`View ${img.alt}`}
            title={img.alt}
            style={{ lineHeight: 0, borderRadius: 8, cursor: 'zoom-in', maxWidth: '100%' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.src}
              alt={img.alt}
              style={{
                ...thumbStyle,
                borderRadius: 8,
                display: 'block',
                border: '1px solid var(--border-input)',
              }}
            />
          </button>
        ))}
      </div>

      {openAt !== null && (
        <ImageLightbox images={images} startIndex={openAt} onClose={() => setOpenAt(null)} />
      )}
    </>
  );
}
