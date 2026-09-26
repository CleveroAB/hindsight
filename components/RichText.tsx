// Renders an agent summary parsed by lib/richText: paragraphs, bullet lists
// and bold labels. Everything is plain React text — no HTML is injected.

import { Fragment, useMemo } from 'react';
import { parseRichText, type RichSpan } from '@/lib/richText';

function Spans({ spans }: { spans: RichSpan[] }) {
  return (
    <>
      {spans.map((span, i) =>
        span.bold ? (
          <strong key={i} style={{ fontWeight: 650, color: 'var(--text)' }}>
            {span.text}
          </strong>
        ) : (
          <Fragment key={i}>{span.text}</Fragment>
        ),
      )}
    </>
  );
}

export default function RichText({ text, gap = 10 }: { text: string; gap?: number }) {
  const blocks = useMemo(() => parseRichText(text), [text]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {blocks.map((block, i) =>
        block.kind === 'paragraph' ? (
          <p key={i} style={{ margin: 0 }}>
            <Spans spans={block.spans} />
          </p>
        ) : (
          <ul
            key={i}
            style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}
          >
            {block.items.map((item, j) => (
              <li key={j}>
                <Spans spans={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}
