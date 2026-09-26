import { describe, expect, test } from 'bun:test';
import { parseRichText, richTextToPlain } from '@/lib/richText';

describe('parseRichText', () => {
  test('labels, bullets and paragraphs', () => {
    const blocks = parseRichText(
      'Monthly momentum on ten Swedish large caps.\n\n**Results**\n- Strategy: +87.9%\n- SPY: **+98.6%**\n\nPrices frozen.',
    );
    expect(blocks).toEqual([
      { kind: 'paragraph', spans: [{ text: 'Monthly momentum on ten Swedish large caps.', bold: false }] },
      { kind: 'paragraph', spans: [{ text: 'Results', bold: true }] },
      {
        kind: 'list',
        items: [
          [{ text: 'Strategy: +87.9%', bold: false }],
          [
            { text: 'SPY: ', bold: false },
            { text: '+98.6%', bold: true },
          ],
        ],
      },
      { kind: 'paragraph', spans: [{ text: 'Prices frozen.', bold: false }] },
    ]);
  });

  test('splits a legacy wall of text on sentence ends, not decimals', () => {
    const sentence = 'SEK 10,000 → 18,792.36, +87.9% total and 18.4% annualized over the tested period. ';
    const blocks = parseRichText(sentence.repeat(8));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.kind).toBe('paragraph');
      const text = block.kind === 'paragraph' ? block.spans.map((s) => s.text).join('') : '';
      expect(text.startsWith('SEK 10,000')).toBe(true);
    }
  });

  test('short single-line text stays one paragraph', () => {
    expect(parseRichText('Done.')).toEqual([{ kind: 'paragraph', spans: [{ text: 'Done.', bold: false }] }]);
  });
});

test('richTextToPlain drops bold markers', () => {
  expect(richTextToPlain('**Results**\n- a')).toBe('Results\n- a');
});
