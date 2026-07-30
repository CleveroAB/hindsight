// Filesystem path helpers (lib/server/paths.ts). Session ids and upload names
// arrive from HTTP requests and get interpolated into paths, so the validators
// here are a path-traversal boundary as much as a convenience.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  dataDir,
  isValidSessionId,
  sessionFile,
  sessionsDir,
  uploadFile,
  uploadsDir,
  workDataDir,
  workDir,
} from '@/lib/server/paths';

let previous: string | undefined;

beforeAll(() => {
  previous = process.env.HINDSIGHT_DATA_DIR;
});

afterAll(() => {
  if (previous === undefined) delete process.env.HINDSIGHT_DATA_DIR;
  else process.env.HINDSIGHT_DATA_DIR = previous;
});

describe('isValidSessionId', () => {
  test('accepts the nanoid alphabet', () => {
    expect(isValidSessionId('V1StGXR8_Z5jdHi6B-myT')).toBe(true);
    expect(isValidSessionId('a')).toBe(true);
    expect(isValidSessionId('a'.repeat(64))).toBe(true);
  });

  test.each([
    [''],
    ['a'.repeat(65)],
    ['..'],
    ['../etc/passwd'],
    ['foo/bar'],
    ['foo\\bar'],
    ['foo.json'],
    ['.'],
    ['with space'],
    ['null\0byte'],
  ])('rejects %p', (id) => {
    expect(isValidSessionId(id)).toBe(false);
  });
});

describe('uploadFile', () => {
  test('resolves a server-generated name inside the uploads dir', () => {
    const full = uploadFile('sess1', 'V1StGXR8Z5jdHi6BmyT.png');
    expect(full).toBe(path.join(uploadsDir('sess1'), 'V1StGXR8Z5jdHi6BmyT.png'));
  });

  test.each([['png'], ['jpg'], ['webp'], ['gif']])('accepts the %s extension', (ext) => {
    expect(uploadFile('sess1', `abc123.${ext}`)).not.toBeNull();
  });

  test.each([
    ['../../../etc/passwd'],
    ['../secret.png'],
    ['sub/dir.png'],
    ['/etc/passwd'],
    ['noextension'],
    ['.png'],
    ['trailingdot.'],
    ['too.longextension'],
    ['UPPER.PNG'], // extensions are lowercase by construction
    ['a'.repeat(65) + '.png'],
  ])('refuses %p', (name) => {
    expect(uploadFile('sess1', name)).toBeNull();
  });

  test('never escapes the uploads directory for any accepted name', () => {
    const dir = uploadsDir('sess1');
    for (const name of ['a.png', 'z-9_Q.webp', 'A1.gif']) {
      const full = uploadFile('sess1', name);
      expect(full).not.toBeNull();
      expect(path.dirname(full as string)).toBe(dir);
    }
  });
});

describe('dataDir', () => {
  test('defaults to <cwd>/data', () => {
    delete process.env.HINDSIGHT_DATA_DIR;
    expect(dataDir()).toBe(path.join(process.cwd(), 'data'));
  });

  test('honours an absolute HINDSIGHT_DATA_DIR', () => {
    process.env.HINDSIGHT_DATA_DIR = '/var/tmp/hindsight-data';
    expect(dataDir()).toBe('/var/tmp/hindsight-data');
  });

  test('resolves a relative HINDSIGHT_DATA_DIR against the cwd', () => {
    process.env.HINDSIGHT_DATA_DIR = './custom-data';
    expect(dataDir()).toBe(path.resolve(process.cwd(), './custom-data'));
  });

  test('an all-whitespace value falls back to the default', () => {
    process.env.HINDSIGHT_DATA_DIR = '   ';
    expect(dataDir()).toBe(path.join(process.cwd(), 'data'));
  });
});

describe('layout (PROTOCOL §1)', () => {
  beforeAll(() => {
    process.env.HINDSIGHT_DATA_DIR = '/tmp/hs-layout';
  });

  test('sessions live at ${data}/sessions/<id>.json', () => {
    expect(sessionsDir()).toBe('/tmp/hs-layout/sessions');
    expect(sessionFile('abc')).toBe('/tmp/hs-layout/sessions/abc.json');
  });

  test('the workdir is ${data}/work/<id>', () => {
    expect(workDir('abc')).toBe('/tmp/hs-layout/work/abc');
  });

  test('uploads is a SIBLING of data, so a refresh run never destroys images', () => {
    // PROTOCOL §1: a "refresh data" run rm -rf's work/<id>/data. If uploads
    // lived inside it, every attached image would vanish with the price cache.
    expect(workDataDir('abc')).toBe('/tmp/hs-layout/work/abc/data');
    expect(uploadsDir('abc')).toBe('/tmp/hs-layout/work/abc/uploads');
    expect(uploadsDir('abc').startsWith(workDataDir('abc'))).toBe(false);
    expect(path.dirname(uploadsDir('abc'))).toBe(path.dirname(workDataDir('abc')));
  });
});
