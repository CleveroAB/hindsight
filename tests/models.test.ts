// The model catalog (lib/server/models): Codex's own list, reduced to the
// choices a settings screen offers, and a strategy's own model.

import { describe, expect, test } from 'bun:test';
import {
  effortFor,
  isOfferedModel,
  listModels,
  parseCatalog,
  parseClaudeModels,
  providerOf,
  resetModelsCache,
} from '@/lib/server/models';
import { PUT as putSessionModel } from '@/server/routes/session-model';
import { createSession, getSession } from '@/lib/server/store';
import { withTempDataDir } from './helpers';

const level = (effort: string) => ({ effort, description: '' });

describe('parseCatalog', () => {
  test('keeps the models Codex lists, in its order, with the efforts Hindsight can pass', () => {
    const models = parseCatalog({
      models: [
        { slug: 'internal-review', display_name: 'Review', visibility: 'hide', priority: 1 },
        {
          slug: 'gpt-b', display_name: 'GPT-B', description: 'Fast.', visibility: 'list', priority: 3,
          default_reasoning_level: 'low', supported_reasoning_levels: [level('low'), level('medium')],
        },
        {
          slug: 'gpt-a', display_name: 'GPT-A', description: 'Balanced.', visibility: 'list', priority: 2,
          default_reasoning_level: 'medium', supported_reasoning_levels: [level('medium'), level('ultra'), level('max')],
        },
      ],
    });
    expect(models).toEqual([
      { provider: 'codex', id: 'gpt-a', name: 'GPT-A', description: 'Balanced.', efforts: ['medium', 'max'], defaultEffort: 'medium' },
      { provider: 'codex', id: 'gpt-b', name: 'GPT-B', description: 'Fast.', efforts: ['low', 'medium'], defaultEffort: 'low' },
    ]);
  });

  test('names a model that has no display name, and tolerates junk', () => {
    expect(parseCatalog({ models: [{ slug: 'gpt-5.6-terra' }, null, { display_name: 'No slug' }] })).toEqual([
      {
        provider: 'codex', id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: '',
        efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium',
      },
    ]);
    expect(parseCatalog(null)).toEqual([]);
    expect(parseCatalog({ models: 'nope' })).toEqual([]);
  });
});

describe('Claude models', () => {
  test('the newest model of each family, in the API’s order', () => {
    const models = parseClaudeModels({
      data: [
        { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2' },
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
        { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
        { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
        { id: 'not-claude' },
      ],
    });
    expect(models.map((m) => [m.id, m.name, m.provider])).toEqual([
      ['claude-fable-5-2', 'Claude Fable 5.2', 'claude'],
      ['claude-opus-5-5', 'Claude Opus 5.5', 'claude'],
      ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'claude'],
    ]);
    expect(models[0].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(parseClaudeModels({})).toEqual([]);
  });

  test('a model’s id names its agent, and Claude Code gets an effort it accepts', () => {
    expect(providerOf('claude-opus-5-5')).toBe('claude');
    expect(providerOf('gpt-5.6-terra')).toBe('codex');
    expect(effortFor('claude-opus-5-5', 'minimal')).toBe('low');
    expect(effortFor('claude-opus-5-5', 'high')).toBe('high');
    expect(effortFor('gpt-5.6-terra', 'minimal')).toBe('minimal');
  });
});

describe('listModels without Codex', () => {
  test('the mock agent offers the built-in names and never runs the CLI', async () => {
    resetModelsCache();
    const { models, source } = await listModels();
    expect(source).toBe('builtin');
    expect(models.length).toBeGreaterThan(0);
    expect(await isOfferedModel(models[0].id)).toBe(true);
    expect(await isOfferedModel('not-a-model')).toBe(false);
    expect(await isOfferedModel(null)).toBe(false);
  });
});

describe('PUT /api/sessions/[id]/model', () => {
  withTempDataDir();
  const put = (id: string, body: unknown) =>
    putSessionModel(
      new Request('http://x/', { method: 'PUT', body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    );

  test('sets a strategy’s own model, refuses one Codex does not offer, and clears it', async () => {
    resetModelsCache();
    const offered = (await listModels()).models[0].id;
    const session = await createSession({ prompt: 'buy and hold' });
    expect((await getSession(session.id))?.model).toBeUndefined();

    expect((await put(session.id, { model: offered })).status).toBe(200);
    expect((await getSession(session.id))?.model).toBe(offered);

    const refused = await put(session.id, { model: 'not-a-model' });
    expect(refused.status).toBe(400);
    expect((await getSession(session.id))?.model).toBe(offered);

    expect((await put(session.id, { model: null })).status).toBe(200);
    expect((await getSession(session.id))?.model).toBeUndefined();
  });

  test('a strategy created with a model keeps it', async () => {
    const session = await createSession({ prompt: 'buy and hold', model: 'gpt-5.6-luna' });
    expect((await getSession(session.id))?.model).toBe('gpt-5.6-luna');
  });

  test('an unknown strategy is a 404', async () => {
    expect((await put('missing-session', { model: null })).status).toBe(404);
  });
});
