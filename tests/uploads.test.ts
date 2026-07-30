// ============================================================================
// Image upload validation (lib/server/uploads.ts, PROTOCOL.md §6).
//
// Uploads are the one path where browser-supplied bytes AND a browser-supplied
// filename reach the filesystem — and the files are then mounted into the agent
// container. Three defenses are asserted here: the declared MIME type must match
// the magic bytes, SVG is never accepted, and the stored filename is always
// server-generated so nothing the client sends can steer a path.
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from '@/lib/types';
import { uploadsDir } from '@/lib/server/paths';
import {
  UploadError,
  imagePartsOf,
  saveAttachments,
  validateImages,
  writeImages,
} from '@/lib/server/uploads';
import {
  GIF_BYTES,
  JPEG_BYTES,
  PNG_BYTES,
  SVG_BYTES,
  WEBP_BYTES,
  imageFile,
  withTempDataDir,
} from './helpers';

withTempDataDir();

describe('accepted formats', () => {
  test.each([
    ['image/png', PNG_BYTES, 'png'],
    ['image/jpeg', JPEG_BYTES, 'jpg'],
    ['image/webp', WEBP_BYTES, 'webp'],
    ['image/gif', GIF_BYTES, 'gif'],
  ])('%s passes and gets the %s extension', async (type, bytes, ext) => {
    const [validated] = await validateImages([imageFile(bytes, `chart.${ext}`, type)]);
    expect(validated.attachment.mimeType).toBe(type);
    expect(validated.attachment.name.endsWith(`.${ext}`)).toBe(true);
  });

  test('records the original filename as a label and the real size', async () => {
    const file = imageFile(PNG_BYTES, 'my chart.png', 'image/png');
    const [validated] = await validateImages([file]);
    expect(validated.attachment.originalName).toBe('my chart.png');
    expect(validated.attachment.size).toBe(PNG_BYTES.byteLength);
  });

  test('an empty batch is fine', async () => {
    expect(await validateImages([])).toEqual([]);
  });

  test('accepts exactly the per-message maximum', async () => {
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) =>
      imageFile(PNG_BYTES, `c${i}.png`, 'image/png'),
    );
    expect(await validateImages(files)).toHaveLength(MAX_IMAGES_PER_MESSAGE);
  });
});

describe('the stored filename is server-generated', () => {
  test('a traversal attempt in the client filename cannot reach the name on disk', async () => {
    const file = imageFile(PNG_BYTES, '../../../../etc/cron.d/evil.png', 'image/png');
    const [validated] = await validateImages([file]);
    expect(validated.attachment.name).toMatch(/^[A-Za-z0-9_-]+\.png$/);
    expect(validated.attachment.name).not.toContain('/');
    expect(validated.attachment.name).not.toContain('..');
    // The hostile string survives only as a display label.
    expect(validated.attachment.originalName).toBe('../../../../etc/cron.d/evil.png');
  });

  test('names are unique across a batch', async () => {
    const files = Array.from({ length: 4 }, () => imageFile(PNG_BYTES, 'same.png', 'image/png'));
    const names = (await validateImages(files)).map((v) => v.attachment.name);
    expect(new Set(names).size).toBe(4);
  });

  test('a nameless paste still gets a label', async () => {
    const [validated] = await validateImages([imageFile(PNG_BYTES, '', 'image/png')]);
    expect(validated.attachment.originalName).toBe('image');
  });
});

describe('rejections', () => {
  test('more than the per-message cap', async () => {
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, (_, i) =>
      imageFile(PNG_BYTES, `c${i}.png`, 'image/png'),
    );
    await expect(validateImages(files)).rejects.toThrow(UploadError);
    await expect(validateImages(files)).rejects.toThrow(/At most 4 images/);
  });

  test('an empty file', async () => {
    const empty = imageFile(new Uint8Array(0), 'empty.png', 'image/png');
    await expect(validateImages([empty])).rejects.toThrow(/was empty/);
  });

  test('a file over the size cap', async () => {
    const big = imageFile(new Uint8Array(MAX_IMAGE_BYTES + 1), 'big.png', 'image/png');
    await expect(validateImages([big])).rejects.toThrow(/larger than 10 MB/);
  });

  test.each([
    ['image/svg+xml'],
    ['text/html'],
    ['application/pdf'],
    ['image/bmp'],
    [''],
  ])('the disallowed type %p', async (type) => {
    const file = imageFile(PNG_BYTES, 'x', type);
    await expect(validateImages([file])).rejects.toThrow(/not a PNG, JPEG, WebP, or GIF/);
  });

  test('SVG is refused even when it claims to be a PNG — it is script-bearing', async () => {
    const file = imageFile(SVG_BYTES, 'logo.png', 'image/png');
    await expect(validateImages([file])).rejects.toThrow(/doesn't look like a valid image\/png/);
  });

  test('a declared type that contradicts the magic bytes', async () => {
    const file = imageFile(JPEG_BYTES, 'photo.png', 'image/png');
    await expect(validateImages([file])).rejects.toThrow(/doesn't look like a valid image\/png/);
  });

  test('a truncated header is not a valid image', async () => {
    const file = imageFile(new Uint8Array([0x89, 0x50]), 'tiny.png', 'image/png');
    await expect(validateImages([file])).rejects.toThrow(UploadError);
  });

  test('RIFF that is not WEBP is refused', async () => {
    const riffOnly = new Uint8Array(16);
    riffOnly.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF", no "WEBP" at offset 8
    const file = imageFile(riffOnly, 'a.webp', 'image/webp');
    await expect(validateImages([file])).rejects.toThrow(UploadError);
  });

  test('the whole batch is rejected when any one file is bad', async () => {
    // PROTOCOL §6: "a batch is validated in full before anything is written",
    // so a rejected message must leave no files behind.
    const files = [
      imageFile(PNG_BYTES, 'good.png', 'image/png'),
      imageFile(SVG_BYTES, 'bad.png', 'image/png'),
    ];
    await expect(validateImages(files)).rejects.toThrow(UploadError);
  });
});

describe('writing to disk', () => {
  test('writeImages lands the bytes under the session uploads dir', async () => {
    const validated = await validateImages([imageFile(PNG_BYTES, 'chart.png', 'image/png')]);
    const saved = await writeImages('sess-write', validated);

    expect(saved).toHaveLength(1);
    const onDisk = await readFile(`${uploadsDir('sess-write')}/${saved[0].name}`);
    expect(Array.from(onDisk)).toEqual(Array.from(PNG_BYTES));
  });

  test('writeImages with nothing to write creates no directory', async () => {
    expect(await writeImages('sess-empty', [])).toEqual([]);
    await expect(readdir(uploadsDir('sess-empty'))).rejects.toThrow();
  });

  test('saveAttachments validates and writes in one step', async () => {
    const saved = await saveAttachments('sess-save', [
      imageFile(PNG_BYTES, 'a.png', 'image/png'),
      imageFile(GIF_BYTES, 'b.gif', 'image/gif'),
    ]);
    expect(saved).toHaveLength(2);
    const names = await readdir(uploadsDir('sess-save'));
    expect(names.sort()).toEqual(saved.map((a) => a.name).sort());
  });

  test('a rejected batch writes nothing at all', async () => {
    const attempt = saveAttachments('sess-reject', [
      imageFile(PNG_BYTES, 'good.png', 'image/png'),
      imageFile(SVG_BYTES, 'bad.png', 'image/png'),
    ]);
    await expect(attempt).rejects.toThrow(UploadError);
    await attempt.catch(() => {});
    await expect(readdir(uploadsDir('sess-reject'))).rejects.toThrow();
  });
});

describe('imagePartsOf', () => {
  test('picks up every `image` part', () => {
    const form = new FormData();
    form.append('text', 'match this chart');
    form.append('image', imageFile(PNG_BYTES, 'a.png', 'image/png'));
    form.append('image', imageFile(GIF_BYTES, 'b.gif', 'image/gif'));
    expect(imagePartsOf(form)).toHaveLength(2);
  });

  test('ignores non-file `image` fields and other parts', () => {
    const form = new FormData();
    form.append('image', 'not-a-file');
    form.append('text', 'hello');
    expect(imagePartsOf(form)).toHaveLength(0);
  });

  test('an empty form yields no images', () => {
    expect(imagePartsOf(new FormData())).toEqual([]);
  });
});
