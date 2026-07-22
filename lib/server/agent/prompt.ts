// ============================================================================
// buildCodexPrompt — composes the natural-language instruction handed to
// `codex exec` inside the Docker container (via the HS_PROMPT env var).
//
// The container's /work/AGENTS.md carries the full, authoritative rules; this
// prompt points the agent at them and states the task. It is used for the two
// LLM-driven run kinds:
//   * initial — build strategy.py from the session's prompt and run it.
//   * refine  — edit the existing strategy.py to satisfy a change request.
// Pure rerun/refresh runs do NOT call the model (the container just re-executes
// strategy.py), so this is a no-op path for them — but it still returns a sane
// prompt if ever invoked.
// ============================================================================

import type { RunKind } from '@/lib/agent-runner';
import type { Attachment, Session } from '@/lib/types';

/** Shared "how to operate in /work" block, with the concrete run params baked in. */
function protocolBlock(session: Session): string {
  const { period, startingCapital } = session;
  return [
    'Operate entirely inside /work. Read /work/AGENTS.md first and FOLLOW IT EXACTLY.',
    '',
    'Inputs & outputs:',
    `- /work/params.json holds the run parameters (currently start=${period.start}, end=${period.end}, startingCapital=${startingCapital}). READ them from the file — never hard-code — so a date-only re-run needs no model.`,
    '- Write your backtest program to /work/strategy.py. It must run standalone via `python /work/strategy.py`, because a plain re-run reuses it with a fresh params.json and no model.',
    '- Cache every fetched dataset under /work/data/ and reuse it when present (that directory is the per-session snapshot; a refresh run starts with it empty).',
    '- Stream progress by APPENDING one JSON object per line to /work/events.ndjson:',
    '    {"type":"status","label":"Tinkering…"}',
    '    {"type":"step","id":"data","label":"Prices fetched, 2016–2025","state":"done"}',
    '    {"type":"meta","name":"…","description":"…"}',
    '    {"type":"message","role":"agent","text":"…"}',
    '  Emit the meta event as EARLY as you can name the strategy.',
    '- On success write /work/result.json and exit 0. Shape:',
    '    {name, description, startingCapital, finalValue, returnPct,',
    '     equityCurve: [[isoDate, value], …] (ascending), benchmark (or null),',
    '     code: <the strategy.py source>, period: {start, end}}',
    '',
    'Realism (mandatory — the backtest is worthless without it):',
    '- Use split/dividend-adjusted (total-return) prices.',
    '- Apply transaction costs (~5 bps/trade) and slippage (~5 bps).',
    '- Model shorting honestly: borrow availability + a borrow fee (~1%/yr, higher for hard-to-borrow) and correct short P&L sign.',
    '- No lookahead: a signal formed at a bar close acts on the NEXT bar.',
    '- Avoid survivorship bias: include delisted names when the universe implies them; if data forces an approximation, say so.',
    '- Finish with a short, honest {"type":"message","role":"agent"} summary naming the rebalance cadence, the costs modeled, the headline return, and any data caveats.',
  ].join('\n');
}

/**
 * Tell the agent about images attached to this turn. They're already passed to
 * the model with `codex exec -i`, so it can SEE them — but saying so (and
 * naming the on-disk paths) is what makes them actionable: the model knows the
 * request may live in the picture, and can re-open a file to look closer.
 */
function attachmentBlock(attachments: Attachment[] | undefined): string[] {
  if (!attachments?.length) return [];
  const list = attachments.map((a) => `- /work/uploads/${a.name} ("${a.originalName}")`);
  return [
    '',
    attachments.length === 1
      ? 'An image is attached to this request and is already visible to you:'
      : 'Images are attached to this request and are already visible to you:',
    ...list,
    'Read the request out of the image(s) as well as the text — a chart, a table, or a screenshot may BE the instruction. Say in your summary how you interpreted them.',
  ];
}

export function buildCodexPrompt(input: {
  session: Session;
  kind: RunKind;
  message?: string;
  attachments?: Attachment[];
}): string {
  const { session, kind, message, attachments } = input;

  if (kind === 'refine') {
    const text = (message ?? '').trim();
    return [
      'You are REFINING an existing backtest that already lives in /work.',
      '',
      'The current program is /work/strategy.py. Modify it to satisfy the change request below, preserving the original strategy intent otherwise, then re-run it end-to-end and rewrite /work/result.json.',
      '',
      'Change request:',
      '"""',
      text || '(no text — the request is in the attached image(s))',
      '"""',
      ...attachmentBlock(attachments),
      '',
      protocolBlock(session),
    ].join('\n');
  }

  // initial (and a safe default for any other kind that reaches here)
  return [
    'You are BUILDING a rigorous historical backtest of an investment strategy from a natural-language description.',
    '',
    'Strategy:',
    '"""',
    session.prompt.trim(),
    '"""',
    ...attachmentBlock(attachments),
    '',
    protocolBlock(session),
  ].join('\n');
}
