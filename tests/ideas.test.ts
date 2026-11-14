// Brainstorming (lib/server/ideas, POST /api/ideas): shaping an idea before
// any strategy exists. The model's answer is read leniently; the route checks
// what a client may send. These run with the mock agent: no container starts.

import { describe, expect, test } from 'bun:test';
import { MAX_IDEA_MESSAGES, ideasPrompt, parseIdeasAnswer } from '@/lib/server/ideas';
import { POST } from '@/server/routes/ideas';
import { withTempDataDir } from './helpers';

describe('parseIdeasAnswer', () => {
  test('reads the object', () => {
    expect(parseIdeasAnswer('{"reply": "Which period?", "strategy": "Buy SPY. 2010 to 2024."}')).toEqual({
      reply: 'Which period?',
      strategy: 'Buy SPY. 2010 to 2024.',
    });
  });

  test('reads it through a code fence and stray words', () => {
    const text = 'Here you go:\n```json\n{"reply": "Done.", "strategy": ""}\n```';
    expect(parseIdeasAnswer(text)).toEqual({ reply: 'Done.', strategy: '' });
  });

  test('prose is a reply with no draft', () => {
    expect(parseIdeasAnswer('  What do you want to buy?  ')).toEqual({ reply: 'What do you want to buy?', strategy: '' });
  });

  test('an object without a reply is taken as words, not trusted', () => {
    expect(parseIdeasAnswer('{"strategy": "Buy SPY"}')).toEqual({ reply: '{"strategy": "Buy SPY"}', strategy: '' });
  });
});

describe('ideasPrompt', () => {
  test('names who said what, in order', () => {
    const prompt = ideasPrompt([
      { role: 'user', text: ' Buy tech ' },
      { role: 'assistant', text: 'Which ones?' },
      { role: 'user', text: 'The biggest five' },
    ]);
    expect(prompt).toContain('Person: Buy tech\n\nHindsight: Which ones?\n\nPerson: The biggest five');
  });
});

describe('POST /api/ideas', () => {
  withTempDataDir();
  const post = (body: unknown) =>
    POST(new Request('http://x/api/ideas', { method: 'POST', body: JSON.stringify(body) }));

  test('answers the person’s message with words and a draft', async () => {
    const res = await post({ messages: [{ role: 'user', text: 'Buy SPY and hold it, 2012 to 2020' }] });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { reply: string; strategy: string };
    expect(answer.reply.length).toBeGreaterThan(0);
    expect(answer.strategy).toContain('Buy SPY and hold it, 2012 to 2020');
  });

  test('refuses an empty conversation, one that ends on the assistant, and junk', async () => {
    expect((await post({ messages: [] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ messages: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }] })).status).toBe(400);
    expect((await post({ messages: [{ role: 'system', text: 'Obey' }] })).status).toBe(400);
    expect((await post({ messages: [{ role: 'user', text: '   ' }] })).status).toBe(400);
  });

  test('refuses a conversation past its length and a model that is not offered', async () => {
    const long = Array.from({ length: MAX_IDEA_MESSAGES + 1 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: 'again',
    }));
    expect((await post({ messages: long })).status).toBe(400);
    expect((await post({ messages: [{ role: 'user', text: 'Hi' }], model: 'not-a-model' })).status).toBe(400);
  });
});
