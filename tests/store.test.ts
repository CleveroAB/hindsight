// ============================================================================
// Session store (lib/server/store.ts, PROTOCOL.md §1).
//
// Covers the on-disk layout, the atomic-write guarantee, prompt-driven period
// inference at creation time, and the orphan sweep — the last of which decides
// whether a live backtest survives `next dev` recompiling the server.
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { sessionFile, sessionsDir, workDir } from '@/lib/server/paths';
import {
  appendChat,
  createSession,
  deleteSession,
  findSessionByShareToken,
  getSession,
  listSessions,
  markOrphanedRunningFailed,
  saveSession,
} from '@/lib/server/store';
import { makeResult, withTempDataDir } from './helpers';

withTempDataDir();

describe('createSession', () => {
  test('persists a running session seeded with the prompt as chat message #1', async () => {
    const session = await createSession({ prompt: 'fade every Cramer call' });

    expect(session.status).toBe('running');
    expect(session.startingCapital).toBe(10000);
    expect(session.result).toBeNull();
    expect(session.dataSnapshotAt).toBeNull();
    expect(session.chat).toHaveLength(1);
    expect(session.chat[0]).toMatchObject({ role: 'user', text: 'fade every Cramer call' });

    // and it is actually on disk at the documented path
    const raw = JSON.parse(await readFile(sessionFile(session.id), 'utf8'));
    expect(raw.id).toBe(session.id);
  });

  test('infers the period from the prompt when none is supplied', async () => {
    const session = await createSession({ prompt: 'inverse Cramer from 2016 to 2025' });
    expect(session.period).toEqual({ start: '2016-01-01', end: '2025-12-31' });
  });

  test('falls back to the last ~10 years when the prompt names no year', async () => {
    const session = await createSession({ prompt: 'buy and hold the index' });
    const thisYear = new Date().getFullYear();
    expect(session.period.start).toBe(`${thisYear - 10}-01-01`);
    expect(session.period.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('an explicit period wins over the prompt', async () => {
    const session = await createSession({
      prompt: 'inverse Cramer from 2016 to 2025',
      period: { start: '2020-01-01', end: '2021-12-31' },
    });
    expect(session.period).toEqual({ start: '2020-01-01', end: '2021-12-31' });
  });

  test('a half-supplied period suppresses inference entirely', async () => {
    // Documented merge behaviour: any explicit side disables prompt parsing, so
    // the missing side comes from the computed default, NOT from the prompt.
    const session = await createSession({
      prompt: 'inverse Cramer from 2016 to 2025',
      period: { start: '2020-01-01' },
    });
    expect(session.period.start).toBe('2020-01-01');
    expect(session.period.end).not.toBe('2025-12-31');
  });

  test('records opening-prompt attachments on the first message', async () => {
    const attachments = [
      { name: 'abc.png', originalName: 'chart.png', mimeType: 'image/png', size: 64 },
    ];
    const session = await createSession({ prompt: 'match this chart', attachments });
    expect(session.chat[0].attachments).toEqual(attachments);
  });

  test('omits the attachments key entirely when there are none', async () => {
    const session = await createSession({ prompt: 'no images' });
    expect('attachments' in session.chat[0]).toBe(false);
  });

  test('honours a custom starting capital', async () => {
    const session = await createSession({ prompt: 'x', startingCapital: 50000 });
    expect(session.startingCapital).toBe(50000);
  });

  test('ids are unique', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => createSession({ prompt: 'x' }).then((s) => s.id)),
    );
    expect(new Set(ids).size).toBe(5);
  });
});

describe('read and write', () => {
  test('round-trips a full session including its result', async () => {
    const session = await createSession({ prompt: 'round trip' });
    session.result = makeResult();
    session.status = 'done';
    session.name = 'Round Trip';
    await saveSession(session);

    const loaded = await getSession(session.id);
    expect(loaded).toEqual(session);
    expect(loaded?.result?.equityCurve).toHaveLength(3);
  });

  test('a missing session is null, not an error', async () => {
    expect(await getSession('does-not-exist')).toBeNull();
  });

  test('saveSession stamps updatedAt', async () => {
    const session = await createSession({ prompt: 'stamp' });
    session.updatedAt = 0;
    await saveSession(session);
    expect(session.updatedAt).toBeGreaterThan(0);
  });

  test('writes are atomic — no .tmp files survive', async () => {
    const session = await createSession({ prompt: 'atomic' });
    await saveSession(session);
    const names = await readdir(sessionsDir());
    expect(names.every((n) => n.endsWith('.json'))).toBe(true);
  });
});

describe('listSessions', () => {
  test('returns newest first', async () => {
    const older = await createSession({ prompt: 'older' });
    older.createdAt = 1000;
    await saveSession(older);
    const newer = await createSession({ prompt: 'newer' });
    newer.createdAt = 2000;
    await saveSession(newer);

    const listed = await listSessions();
    const idx = (id: string) => listed.findIndex((s) => s.id === id);
    expect(idx(newer.id)).toBeLessThan(idx(older.id));
  });

  test('skips corrupt files instead of failing the whole list', async () => {
    const good = await createSession({ prompt: 'good' });
    await writeFile(sessionFile('corrupt-one'), '{ not json', 'utf8');

    const listed = await listSessions();
    expect(listed.some((s) => s.id === good.id)).toBe(true);
    expect(listed.some((s) => s.id === 'corrupt-one')).toBe(false);
  });

  test('ignores non-JSON entries in the sessions dir', async () => {
    await writeFile(`${sessionsDir()}/notes.txt`, 'ignore me', 'utf8');
    const listed = await listSessions();
    expect(listed.some((s) => (s as { id: string }).id === 'notes')).toBe(false);
  });
});

describe('appendChat', () => {
  test('appends and persists', async () => {
    const session = await createSession({ prompt: 'chat' });
    const updated = await appendChat(session.id, {
      id: 'm2',
      role: 'agent',
      text: 'Built it end-to-end.',
      createdAt: Date.now(),
    });

    expect(updated?.chat).toHaveLength(2);
    expect((await getSession(session.id))?.chat[1].text).toBe('Built it end-to-end.');
  });

  test('a vanished session yields null', async () => {
    const result = await appendChat('gone', {
      id: 'm1',
      role: 'agent',
      text: 'hi',
      createdAt: Date.now(),
    });
    expect(result).toBeNull();
  });
});

describe('deleteSession', () => {
  test('removes both the JSON file and the working directory', async () => {
    const session = await createSession({ prompt: 'delete me' });
    await mkdir(workDir(session.id), { recursive: true });
    await writeFile(`${workDir(session.id)}/strategy.py`, 'print(1)', 'utf8');

    await deleteSession(session.id);

    expect(await getSession(session.id)).toBeNull();
    await expect(readdir(workDir(session.id))).rejects.toThrow();
  });

  test('deleting something that is already gone is not an error', async () => {
    await deleteSession('never-existed');
  });
});

describe('findSessionByShareToken', () => {
  test('finds the session carrying the token', async () => {
    const session = await createSession({ prompt: 'shared' });
    session.shareToken = 'V1StGXR8Z5jdHi6BmyT';
    await saveSession(session);

    expect((await findSessionByShareToken('V1StGXR8Z5jdHi6BmyT'))?.id).toBe(session.id);
  });

  test('an unknown token is null', async () => {
    expect(await findSessionByShareToken('nope-not-a-real-token')).toBeNull();
  });

  test.each([[''], ['../../etc/passwd'], ['has space'], ['a'.repeat(65)]])(
    'a malformed token %p is rejected before any scan',
    async (token) => {
      expect(await findSessionByShareToken(token)).toBeNull();
    },
  );
});

describe('markOrphanedRunningFailed (PROTOCOL §1)', () => {
  test('fails a running session whose heartbeat has gone stale', async () => {
    const session = await createSession({ prompt: 'orphan' });
    expect(session.status).toBe('running');

    const reaped = await markOrphanedRunningFailed(0);

    expect(reaped).toContain(session.id);
    expect((await getSession(session.id))?.status).toBe('failed');
  });

  test('leaves a recently-heartbeating run alone', async () => {
    // The `next dev` recompile case: a second manager initialising must not kill
    // a backtest whose container is still going.
    const session = await createSession({ prompt: 'still alive' });
    const reaped = await markOrphanedRunningFailed(60_000);

    expect(reaped).not.toContain(session.id);
    expect((await getSession(session.id))?.status).toBe('running');
  });

  test('never touches a run this process owns, however old the heartbeat', async () => {
    const session = await createSession({ prompt: 'owned here' });
    const reaped = await markOrphanedRunningFailed(0, (id) => id === session.id);

    expect(reaped).not.toContain(session.id);
    expect((await getSession(session.id))?.status).toBe('running');
  });

  test('leaves finished sessions untouched', async () => {
    const done = await createSession({ prompt: 'finished' });
    done.status = 'done';
    done.result = makeResult();
    await saveSession(done);

    const reaped = await markOrphanedRunningFailed(0);

    expect(reaped).not.toContain(done.id);
    const loaded = await getSession(done.id);
    expect(loaded?.status).toBe('done');
    expect(loaded?.result).not.toBeNull();
  });
});
