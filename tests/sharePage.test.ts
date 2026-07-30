// ============================================================================
// The read-only share page (lib/server/sharePage.ts, PROTOCOL.md §6).
//
// This is the ONLY document a tunnel visitor can reach, so two properties carry
// real weight: everything interpolated into it is escaped (the name, description
// and Python all originate from an LLM), and it is genuinely self-contained —
// no <script>, no /_next assets, no API calls — because proxy.ts 404s every
// other path and any external reference would render as a broken page.
// ============================================================================

import { describe, expect, test } from 'bun:test';
import { renderSharePage, renderShareNotFound } from '@/lib/server/sharePage';
import { makeResult, makeSession, points } from './helpers';

const session = makeSession({
  name: 'Inverse Cramer',
  description: 'Fade every Cramer call, weekly rebalance',
  period: { start: '2016-01-01', end: '2025-12-31' },
  result: makeResult({
    equityCurve: points(['2016-01-04', 10000], ['2020-06-01', 18000], ['2025-12-31', 30642.05]),
    finalValue: 30642.05,
    returnPct: 206.4,
    code: 'import pandas as pd\nprint("hi")',
  }),
});

describe('a finished strategy', () => {
  const html = renderSharePage(session);

  test('is a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  test('shows the headline figures and the strategy name', () => {
    expect(html).toContain('$30,642.05');
    expect(html).toContain('+206.4%');
    expect(html).toContain('Inverse Cramer');
    expect(html).toContain('Fade every Cramer call, weekly rebalance');
  });

  test('renders the equity curve as inline SVG', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('viewBox="0 0 800 300"');
    expect(html).toContain('<path');
  });

  test('includes the strategy source behind a disclosure', () => {
    expect(html).toContain('<details>');
    expect(html).toContain('import pandas as pd');
  });

  test('marks the run as a simulation, not advice', () => {
    expect(html).toContain('not investment advice');
  });

  test('asks not to be indexed', () => {
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');
  });
});

describe('self-containment', () => {
  const html = renderSharePage(session);

  test('carries no JavaScript', () => {
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onload=');
    expect(html).not.toContain('onerror=');
  });

  test('references no Next.js assets or API routes', () => {
    // proxy.ts 404s these for tunnel visitors, so any reference is a broken page.
    expect(html).not.toContain('/_next');
    expect(html).not.toContain('/api/');
  });

  test('loads nothing over the network', () => {
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  test('styles are inline', () => {
    expect(html).toContain('<style>');
  });
});

describe('escaping (the content is LLM-authored)', () => {
  test('a script tag in the strategy name cannot break out', () => {
    const html = renderSharePage(
      makeSession({ name: '<script>alert(1)</script>', result: makeResult() }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('the description is escaped', () => {
    const html = renderSharePage(
      makeSession({ description: '<img src=x onerror=alert(1)>', result: makeResult() }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  test('the Python source is escaped', () => {
    const html = renderSharePage(
      makeSession({ result: makeResult({ code: 'x = "</pre><script>alert(1)</script>"' }) }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/pre&gt;');
  });

  test('quotes and ampersands are escaped', () => {
    const html = renderSharePage(
      makeSession({ name: `Tom & "Jerry" 's`, result: makeResult() }),
    );
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#39;');
  });

  test('the title is escaped too', () => {
    const html = renderSharePage(
      makeSession({ name: '</title><script>alert(1)</script>', result: makeResult() }),
    );
    expect(html).not.toContain('</title><script>');
  });
});

describe('sign-dependent styling', () => {
  test('a gain uses the positive class', () => {
    const html = renderSharePage(
      makeSession({ result: makeResult({ returnPct: 206.4, finalValue: 30642.05 }) }),
    );
    expect(html).toContain('class="change num pos"');
  });

  test('a loss uses the negative class', () => {
    const html = renderSharePage(
      makeSession({ result: makeResult({ returnPct: -23.8, finalValue: 7620 }) }),
    );
    expect(html).toContain('class="change num neg"');
    expect(html).toContain('−23.8%');
  });
});

describe('incomplete or missing content', () => {
  test('a session with no result explains itself instead of erroring', () => {
    const html = renderSharePage(makeSession({ result: null }));
    expect(html).toContain('no completed backtest yet');
    expect(html).not.toContain('<svg');
  });

  test('an unnamed strategy gets a placeholder title', () => {
    const html = renderSharePage(makeSession({ name: '', result: makeResult() }));
    expect(html).toContain('Untitled strategy');
  });

  test('the code disclosure is omitted when there is no code', () => {
    const html = renderSharePage(makeSession({ result: makeResult({ code: undefined }) }));
    expect(html).not.toContain('<details>');
  });

  test('a single-point curve still renders', () => {
    const html = renderSharePage(
      makeSession({ result: makeResult({ equityCurve: points(['2020-01-01', 10000]) }) }),
    );
    expect(html).toContain('<svg');
  });
});

describe('year ticks', () => {
  test('a multi-year period labels both ends', () => {
    const html = renderSharePage(session);
    expect(html).toContain('>2016<');
    expect(html).toContain('>2025<');
  });

  test('a single-year period labels just the one year', () => {
    const html = renderSharePage(
      makeSession({
        period: { start: '2020-01-01', end: '2020-12-31' },
        result: makeResult(),
      }),
    );
    expect(html).toContain('>2020<');
  });
});

describe('renderShareNotFound', () => {
  const html = renderShareNotFound();

  test('is the same self-contained shell', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('<script');
  });

  test('says the link is gone without revealing anything about it', () => {
    expect(html).toContain('doesn’t exist or has been turned off');
    expect(html).not.toContain('Inverse Cramer');
  });
});
