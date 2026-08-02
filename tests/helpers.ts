// ============================================================================
// Shared test fixtures.
//
// Two things every server-side test needs: a Session that satisfies the type
// contract without 40 lines of boilerplate, and an isolated HINDSIGHT_DATA_DIR
// so a test never reads or writes the developer's real ./data. Tests that touch
// disk call `withTempDataDir()` at the top of their describe block.
// ============================================================================

import { afterAll, beforeAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EquityPoint, Session, StrategyResult } from '@/lib/types';

/** A fresh temp directory, removed by the caller. */
export async function makeTempDir(prefix = 'hindsight-test-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * Point HINDSIGHT_DATA_DIR at a throwaway directory for the duration of a
 * describe block, restoring whatever was there before. Returns a getter (not
 * the path) because the directory only exists once beforeAll has run.
 */
export function withTempDataDir(): () => string {
  let dir = '';
  let previous: string | undefined;

  beforeAll(async () => {
    previous = process.env.HINDSIGHT_DATA_DIR;
    dir = await makeTempDir();
    process.env.HINDSIGHT_DATA_DIR = dir;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.HINDSIGHT_DATA_DIR;
    else process.env.HINDSIGHT_DATA_DIR = previous;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  return () => dir;
}

/** A minimal valid Session; override any field via `patch`. */
export function makeSession(patch: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id: 'test-session',
    name: 'Test Strategy',
    description: 'A strategy for tests',
    prompt: 'buy and hold',
    period: { start: '2016-01-01', end: '2025-12-31' },
    startingCapital: 10000,
    status: 'done',
    result: null,
    chat: [],
    backtests: [],
    dataSnapshotAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

/** A minimal valid StrategyResult; override any field via `patch`. */
export function makeResult(patch: Partial<StrategyResult> = {}): StrategyResult {
  return {
    equityCurve: [
      { date: '2016-01-04', value: 10000 },
      { date: '2016-01-05', value: 10500 },
      { date: '2016-01-06', value: 12000 },
    ],
    benchmark: null,
    finalValue: 12000,
    startingCapital: 10000,
    returnPct: 20,
    ranAt: Date.now(),
    durationMs: 41000,
    ...patch,
  };
}

/** `[date, value]` pairs as an EquityPoint[] — compact curve fixtures. */
export function points(...pairs: Array<[string, number]>): EquityPoint[] {
  return pairs.map(([date, value]) => ({ date, value }));
}

// ---------------------------------------------------------------------------
// Image fixtures. Real magic bytes, because uploads.ts sniffs them (PROTOCOL §6).
// ---------------------------------------------------------------------------

function withPadding(header: number[], totalBytes = 64): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(header, 0);
  return bytes;
}

export const PNG_BYTES = withPadding([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_BYTES = withPadding([0xff, 0xd8, 0xff, 0xe0]);
export const GIF_BYTES = withPadding([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
/** `RIFF` + 4 size bytes + `WEBP`. */
export const WEBP_BYTES = withPadding([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
/** Script-bearing and never accepted, whatever the declared type says. */
export const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

/** A File the multipart parser would hand to validateImages(). */
export function imageFile(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}
