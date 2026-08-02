// ============================================================================
// events.ndjson line parsing (PROTOCOL.md §3).
//
// This is the trust boundary between the agent — an LLM writing lines inside a
// container — and the UI. Anything malformed must be dropped silently rather
// than crash the tail or render as garbage, and the agent must not be able to
// forge the terminal frames (`result`/`error`/`done`) the run manager owns.
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { STATUS_WORDS } from '@/lib/agent-runner';
import { parseAgentEvent } from '@/lib/server/agent/codexRunner';

/** Serialize an object the way the agent appends it to events.ndjson. */
const line = (o: unknown): string => JSON.stringify(o);

describe('status', () => {
  test.each(STATUS_WORDS.map((w) => [w]))('forwards the known status word %p', (label) => {
    expect(parseAgentEvent(line({ type: 'status', label }))).toEqual({
      type: 'status',
      label,
      elapsedMs: 0,
    });
  });

  test('elapsedMs is zeroed for the runner to stamp — the agent is not authoritative', () => {
    const parsed = parseAgentEvent(line({ type: 'status', label: 'Crunching…', elapsedMs: 99999 }));
    expect(parsed).toEqual({ type: 'status', label: 'Crunching…', elapsedMs: 0 });
  });

  test.each([
    ['Thinking…'],
    ['Crunching'], // right word, missing the ellipsis glyph
    ['crunching…'],
    [''],
    [42],
    [null],
  ])('drops the unknown status label %p', (label) => {
    // A bogus label would halt the status auto-cycle (indexOf -> -1) and render raw.
    expect(parseAgentEvent(line({ type: 'status', label }))).toBeNull();
  });
});

describe('step', () => {
  test('forwards a well-formed step', () => {
    expect(
      parseAgentEvent(line({ type: 'step', id: 'data', label: 'Prices fetched', state: 'done' })),
    ).toEqual({ type: 'step', id: 'data', label: 'Prices fetched', state: 'done' });
  });

  test.each([['active'], ['done']])('accepts state %p', (state) => {
    expect(parseAgentEvent(line({ type: 'step', id: 'x', label: 'l', state }))).not.toBeNull();
  });

  test('a missing label becomes an empty string rather than "undefined"', () => {
    expect(parseAgentEvent(line({ type: 'step', id: 'data', state: 'done' }))).toEqual({
      type: 'step',
      id: 'data',
      label: '',
      state: 'done',
    });
  });

  test('coerces a non-string label', () => {
    const parsed = parseAgentEvent(line({ type: 'step', id: 'data', label: 7, state: 'done' }));
    expect(parsed).toMatchObject({ label: '7' });
  });

  test.each([
    [{ type: 'step', label: 'no id', state: 'done' }],
    [{ type: 'step', id: 7, label: 'numeric id', state: 'done' }],
    [{ type: 'step', id: 'data', label: 'bad state', state: 'pending' }],
    [{ type: 'step', id: 'data', label: 'no state' }],
  ])('drops the malformed step %p', (obj) => {
    expect(parseAgentEvent(line(obj))).toBeNull();
  });
});

describe('meta', () => {
  test('forwards the strategy name and description', () => {
    expect(
      parseAgentEvent(line({ type: 'meta', name: 'Inverse Cramer', description: 'Fade it' })),
    ).toEqual({ type: 'meta', name: 'Inverse Cramer', description: 'Fade it' });
  });

  test('missing halves become empty strings', () => {
    expect(parseAgentEvent(line({ type: 'meta' }))).toEqual({
      type: 'meta',
      name: '',
      description: '',
    });
  });
});

describe('message', () => {
  test.each(['agent', 'system'] as const)('accepts role %p', (role) => {
    expect(parseAgentEvent(line({ type: 'message', role, text: 'hello' }))).toEqual({
      type: 'message',
      role,
      text: 'hello',
    });
  });

  test('the agent cannot post as the user', () => {
    expect(parseAgentEvent(line({ type: 'message', role: 'user', text: 'hi' }))).toBeNull();
  });

  test.each([[{ type: 'message', text: 'no role' }], [{ type: 'message', role: '', text: 'x' }]])(
    'drops the roleless message %p',
    (obj) => {
      expect(parseAgentEvent(line(obj))).toBeNull();
    },
  );

  test('missing text becomes an empty string', () => {
    expect(parseAgentEvent(line({ type: 'message', role: 'agent' }))).toMatchObject({ text: '' });
  });
});

describe('log', () => {
  test('forwards raw log text', () => {
    expect(parseAgentEvent(line({ type: 'log', text: 'pip install pandas' }))).toEqual({
      type: 'log',
      text: 'pip install pandas',
    });
  });
});

describe('events the agent may not emit', () => {
  test.each([
    [{ type: 'result', result: { equityCurve: [] } }],
    [{ type: 'error', message: 'fake failure' }],
    [{ type: 'done' }],
    [{ type: 'snapshot' }],
    [{ type: 'unknown-future-type' }],
  ])('ignores %p — the run manager owns terminal frames', (obj) => {
    expect(parseAgentEvent(line(obj))).toBeNull();
  });
});

describe('malformed lines', () => {
  test.each([
    [''],
    ['not json'],
    ['{'],
    ['{"type":'],
    ['null'],
    ['123'],
    ['"a bare string"'],
    ['[]'],
    ['[{"type":"log","text":"in an array"}]'],
    ['{}'],
    ['{"label":"Crunching…"}'], // no type
    ['{"type":42}'],
  ])('drops %p without throwing', (raw) => {
    expect(parseAgentEvent(raw)).toBeNull();
  });
});

describe('the canonical initial-run sequence from PROTOCOL §3', () => {
  test('every documented line parses to its event', () => {
    const ndjson = [
      '{"type":"status","label":"Tinkering…"}',
      '{"type":"meta","name":"Inverse Cramer","description":"Fade every Cramer call, weekly rebalance"}',
      '{"type":"step","id":"strategy","label":"Strategy written","state":"done"}',
      '{"type":"status","label":"Sketching…"}',
      '{"type":"step","id":"data","label":"Prices fetched, 2016–2025","state":"done"}',
      '{"type":"status","label":"Crunching…"}',
      '{"type":"step","id":"backtest","label":"Running the backtest","state":"active"}',
    ];

    const parsed = ndjson.map(parseAgentEvent);

    expect(parsed.every((e) => e !== null)).toBe(true);
    expect(parsed.map((e) => e?.type)).toEqual([
      'status',
      'meta',
      'step',
      'status',
      'step',
      'status',
      'step',
    ]);
    expect(parsed[1]).toMatchObject({ name: 'Inverse Cramer' });
    expect(parsed[4]).toMatchObject({ id: 'data', state: 'done' });
  });

  test('a junk line between good ones does not disturb its neighbours', () => {
    const parsed = [
      '{"type":"status","label":"Tinkering…"}',
      'Traceback (most recent call last):',
      '{"type":"step","id":"data","label":"Prices fetched","state":"done"}',
    ].map(parseAgentEvent);

    expect(parsed[0]).toMatchObject({ type: 'status' });
    expect(parsed[1]).toBeNull();
    expect(parsed[2]).toMatchObject({ type: 'step' });
  });
});
