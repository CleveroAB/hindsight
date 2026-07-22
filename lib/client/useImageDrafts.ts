'use client';

// Picking images for a composer — shared by the empty-state composer (a new
// strategy) and the chat's refine input. Owns the draft list, the local preview
// object URLs (and their revocation), and client-side validation that mirrors
// the server's, so a bad pick fails instantly instead of round-tripping.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
} from '@/lib/types';

/** A picked-but-not-yet-sent image, with a local preview URL. */
export interface ImageDraft {
  id: string;
  file: File;
  url: string;
}

/** `accept` attribute value for a file input taking these images. */
export const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',');

const MAX_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

export interface UseImageDrafts {
  drafts: ImageDraft[];
  /** Validation message for the most recent pick, or null. */
  error: string | null;
  addFiles: (files: File[]) => void;
  remove: (id: string) => void;
  /**
   * Hand off the picked files on submit. Returns them plus their preview URLs,
   * and clears the drafts WITHOUT revoking — the caller may still be showing
   * those URLs in an optimistic bubble, and owns revoking them when done.
   */
  take: () => { files: File[]; urls: string[] };
  /** Discard everything and revoke the previews. */
  clear: () => void;
  /** Paste handler: turns image data on the clipboard into drafts. */
  onPaste: (e: React.ClipboardEvent) => void;
  /** Drop handlers for a drop target. */
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}

export function useImageDrafts(disabled = false): UseImageDrafts {
  const [drafts, setDrafts] = useState<ImageDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(0);

  // Revoke whatever is still outstanding on unmount.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(
    () => () => {
      for (const d of draftsRef.current) URL.revokeObjectURL(d.url);
    },
    [],
  );

  // Reads the live draft list from the ref rather than a closure, so back-to-back
  // picks count correctly against the cap without making this callback unstable.
  const addFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    const current = draftsRef.current;
    const accepted: ImageDraft[] = [];
    let err: string | null = null;

    for (const file of incoming) {
      if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
        err = `${file.name || 'That file'} isn't a PNG, JPEG, WebP, or GIF.`;
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        err = `${file.name || 'That image'} is over ${MAX_MB} MB.`;
        continue;
      }
      if (current.length + accepted.length >= MAX_IMAGES_PER_MESSAGE) {
        err = `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`;
        break;
      }
      idRef.current += 1;
      accepted.push({
        id: `draft-${idRef.current}`,
        file,
        url: URL.createObjectURL(file),
      });
    }

    if (accepted.length) {
      const next = [...current, ...accepted];
      draftsRef.current = next;
      setDrafts(next);
    }
    setError(err);
  }, []);

  const remove = useCallback((id: string) => {
    setDrafts((prev) => {
      const hit = prev.find((d) => d.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((d) => d.id !== id);
    });
    setError(null);
  }, []);

  const take = useCallback(() => {
    const files = draftsRef.current.map((d) => d.file);
    const urls = draftsRef.current.map((d) => d.url);
    setDrafts([]);
    setError(null);
    return { files, urls };
  }, []);

  const clear = useCallback(() => {
    for (const d of draftsRef.current) URL.revokeObjectURL(d.url);
    setDrafts([]);
    setError(null);
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (disabled) return;
      const files = Array.from(e.clipboardData.files ?? []).filter((f) =>
        f.type.startsWith('image/'),
      );
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    [addFiles, disabled],
  );

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!disabled) e.preventDefault();
    },
    [disabled],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    [addFiles, disabled],
  );

  return { drafts, error, addFiles, remove, take, clear, onPaste, onDragOver, onDrop };
}
