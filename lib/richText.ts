// Minimal structure for agent summaries. The prompt asks for blank-line
// separated paragraphs, "- " bullets and **bold** section labels; this parses
// exactly that subset (no general Markdown) so the chat can render it without
// a dependency and without trusting arbitrary HTML.
//
// Older summaries were written as one long paragraph. Those are split into
// groups of a few sentences so they stay readable without re-running.

export type RichSpan = { text: string; bold: boolean };
export type RichBlock =
  | { kind: 'paragraph'; spans: RichSpan[] }
  | { kind: 'list'; items: RichSpan[][] };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const LEGACY_MIN_LENGTH = 320;
const LEGACY_TARGET_LENGTH = 240;

export function parseInline(text: string): RichSpan[] {
  const spans: RichSpan[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index), bold: false });
    spans.push({ text: match[1], bold: true });
    last = index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), bold: false });
  return spans;
}

/** Split one unbroken wall of text into paragraphs of a few sentences each. */
function splitLegacyParagraph(text: string): string[] {
  // A sentence ends at . ! or ? followed by whitespace and an uppercase letter;
  // decimals like 18,792.36 never have a space after the dot.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const paragraphs: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    if (current.length >= LEGACY_TARGET_LENGTH) {
      paragraphs.push(current);
      current = '';
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

export function parseRichText(input: string): RichBlock[] {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  if (!text.includes('\n') && text.length >= LEGACY_MIN_LENGTH) {
    return splitLegacyParagraph(text).map((p) => ({ kind: 'paragraph', spans: parseInline(p) }));
  }

  const blocks: RichBlock[] = [];
  let paragraph: string[] = [];
  let list: RichSpan[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: 'list', items: list });
    list = null;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    if (BULLET.test(line)) {
      flushParagraph();
      list ??= [];
      list.push(parseInline(line.replace(BULLET, '')));
      continue;
    }
    if (list) {
      // An indented continuation line belongs to the previous bullet.
      if (/^\s/.test(raw) && list.length) {
        list[list.length - 1].push({ text: ` ${line}`, bold: false });
        continue;
      }
      flushList();
    }
    // A standalone **Label** line is a section heading, not part of prose.
    if (/^\*\*[^*]+\*\*:?$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'paragraph', spans: parseInline(line) });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** The same text with formatting markers removed, for copying. */
export function richTextToPlain(input: string): string {
  return input.replace(/\*\*(.+?)\*\*/g, '$1');
}
