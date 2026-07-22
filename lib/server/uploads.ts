// ============================================================================
// Chat image attachments — validating and storing what the user sends with a
// refinement, so the agent container can read it at /work/uploads/<name>.
//
// Filenames are SERVER-generated (nanoid + an extension derived from the
// validated MIME type). The client's filename is kept only as a label; it never
// touches the filesystem, so nothing the browser sends can steer a path.
// ============================================================================

import { writeFile } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { Attachment } from '@/lib/types';
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
} from '@/lib/types';
import { ensureDir, uploadsDir } from './paths';

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Thrown for anything the client got wrong; routes surface it as a 400. */
export class UploadError extends Error {}

function isAcceptedType(type: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * The first bytes of the file, checked against the declared MIME type. A
 * browser-supplied Content-Type is just a claim; this makes sure what lands in
 * the container is actually the image format we say it is.
 */
function sniff(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** A file that passed validation, with the name it will be written under. */
export interface ValidatedImage {
  attachment: Attachment;
  bytes: Uint8Array;
}

/**
 * Check the `image` parts of a multipart request and assign each a storage
 * name — WITHOUT touching the filesystem. Splitting validation from writing
 * lets a caller reject a bad batch before it creates anything (the create-session
 * route needs a session id to write into, but must not create one for a request
 * that was never going to be accepted).
 *
 * Throws UploadError on anything malformed or oversized.
 */
export async function validateImages(files: File[]): Promise<ValidatedImage[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_IMAGES_PER_MESSAGE) {
    throw new UploadError(`At most ${MAX_IMAGES_PER_MESSAGE} images per message.`);
  }

  const pending: ValidatedImage[] = [];
  for (const file of files) {
    if (file.size === 0) throw new UploadError('One of the images was empty.');
    if (file.size > MAX_IMAGE_BYTES) {
      throw new UploadError(
        `"${file.name}" is larger than ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`,
      );
    }
    if (!isAcceptedType(file.type)) {
      throw new UploadError(`"${file.name}" is not a PNG, JPEG, WebP, or GIF image.`);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const sniffed = sniff(bytes);
    if (sniffed !== file.type) {
      throw new UploadError(`"${file.name}" doesn't look like a valid ${file.type} image.`);
    }

    pending.push({
      attachment: {
        name: `${nanoid()}.${EXTENSIONS[file.type]}`,
        originalName: file.name || 'image',
        mimeType: file.type,
        size: file.size,
      },
      bytes,
    });
  }

  return pending;
}

/** Write validated images into the session's uploads dir. */
export async function writeImages(
  sessionId: string,
  images: ValidatedImage[],
): Promise<Attachment[]> {
  if (images.length === 0) return [];
  const dir = uploadsDir(sessionId);
  await ensureDir(dir);
  const saved: Attachment[] = [];
  for (const { attachment, bytes } of images) {
    await writeFile(`${dir}/${attachment.name}`, bytes);
    saved.push(attachment);
  }
  return saved;
}

/** Validate and write in one step — for callers that already have a session. */
export async function saveAttachments(
  sessionId: string,
  files: File[],
): Promise<Attachment[]> {
  return writeImages(sessionId, await validateImages(files));
}

/** Pull the `image` parts out of a parsed multipart body. */
export function imagePartsOf(form: FormData): File[] {
  return form
    .getAll('image')
    .filter((part): part is File => typeof part === 'object' && part !== null && 'arrayBuffer' in part);
}
