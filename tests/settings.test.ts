// App settings (lib/server/settings.ts, PROTOCOL.md §6). The documented
// precedence is settings.json > HINDSIGHT_CODEX_MODEL > built-in default, and
// anything unreadable must degrade to defaults rather than reach `codex exec`
// and fail the run there.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { dataDir } from '@/lib/server/paths';
import { getSettings, getSettingsSync, settingsFile, updateSettings } from '@/lib/server/settings';
import { withTempDataDir } from './helpers';

const getDir = withTempDataDir();

let previousModel: string | undefined;

beforeAll(() => {
  previousModel = process.env.HINDSIGHT_CODEX_MODEL;
  delete process.env.HINDSIGHT_CODEX_MODEL;
});

afterAll(() => {
  if (previousModel === undefined) delete process.env.HINDSIGHT_CODEX_MODEL;
  else process.env.HINDSIGHT_CODEX_MODEL = previousModel;
});

afterEach(async () => {
  await rm(settingsFile(), { force: true });
  delete process.env.HINDSIGHT_CODEX_MODEL;
});

/** Write a raw settings.json, bypassing updateSettings' validation. */
async function writeRaw(contents: string): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(settingsFile(), contents, 'utf8');
}

describe('defaults', () => {
  test('a missing file yields the built-in defaults', async () => {
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
  });

  test('HINDSIGHT_CODEX_MODEL supplies the default model', async () => {
    process.env.HINDSIGHT_CODEX_MODEL = 'gpt-5.6-luna';
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-luna', effort: 'medium' });
  });

  test('an all-whitespace env var falls back to the built-in default', async () => {
    process.env.HINDSIGHT_CODEX_MODEL = '   ';
    expect((await getSettings()).model).toBe('gpt-5.6-sol');
  });

  test('settings.json out-ranks the env var', async () => {
    process.env.HINDSIGHT_CODEX_MODEL = 'gpt-5.6-luna';
    await updateSettings({ model: 'gpt-5.6-terra' });
    expect((await getSettings()).model).toBe('gpt-5.6-terra');
  });

  test('the file lives at ${data}/settings.json', () => {
    expect(settingsFile()).toBe(`${getDir()}/settings.json`);
  });
});

describe('reading a hand-edited file', () => {
  test('unparseable JSON degrades to defaults', async () => {
    await writeRaw('{ not json at all');
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
  });

  test('a non-object payload degrades to defaults', async () => {
    await writeRaw('"just a string"');
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
  });

  test('an unknown effort falls back rather than reaching codex exec', async () => {
    await writeRaw(JSON.stringify({ model: 'gpt-5.6-sol', effort: 'ludicrous' }));
    expect((await getSettings()).effort).toBe('medium');
  });

  test('but a model the dialog does not offer is kept', async () => {
    await writeRaw(JSON.stringify({ model: 'some-private-model', effort: 'high' }));
    expect(await getSettings()).toEqual({ model: 'some-private-model', effort: 'high' });
  });

  test('an empty model string is not a model', async () => {
    await writeRaw(JSON.stringify({ model: '   ', effort: 'high' }));
    expect((await getSettings()).model).toBe('gpt-5.6-sol');
  });

  test('a model with stray whitespace is trimmed', async () => {
    await writeRaw(JSON.stringify({ model: '  gpt-5.6-terra  ', effort: 'low' }));
    expect((await getSettings()).model).toBe('gpt-5.6-terra');
  });

  test('missing fields fall back individually', async () => {
    await writeRaw(JSON.stringify({ effort: 'xhigh' }));
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh' });
  });
});

describe('updateSettings', () => {
  test('persists and returns the merged result', async () => {
    expect(await updateSettings({ effort: 'high' })).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
  });

  test('a partial patch leaves the other field alone', async () => {
    await updateSettings({ model: 'gpt-5.6-terra', effort: 'max' });
    await updateSettings({ effort: 'minimal' });
    expect(await getSettings()).toEqual({ model: 'gpt-5.6-terra', effort: 'minimal' });
  });

  test('an empty patch is a no-op that still round-trips', async () => {
    await updateSettings({ model: 'gpt-5.6-luna' });
    expect(await updateSettings({})).toEqual({ model: 'gpt-5.6-luna', effort: 'medium' });
  });

  test.each([['minimal'], ['low'], ['medium'], ['high'], ['xhigh'], ['max']])(
    'accepts the %p effort level',
    async (effort) => {
      const saved = await updateSettings({ effort: effort as 'medium' });
      expect(saved.effort).toBe(effort as 'medium');
    },
  );
});

describe('getSettingsSync', () => {
  test('agrees with the async reader', async () => {
    await updateSettings({ model: 'gpt-5.6-terra', effort: 'high' });
    expect(getSettingsSync()).toEqual(await getSettings());
  });

  test('degrades to defaults with no file, since AgentRunner.start() cannot await', async () => {
    expect(getSettingsSync()).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
  });
});
