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
import { latestBacktest, referencedBacktests } from '@/lib/backtests';

/** Full human/agent context, minus mechanical run-duration notices. */
function conversationBlock(session: Session): string[] {
  const messages = session.chat
    .filter(
      (entry) =>
        entry.role !== 'system' || !/^Backtest finished in .+$/i.test(entry.text.trim()),
    )
    .map((entry) => ({
      role: entry.role,
      text: entry.text,
      ...(entry.metadata?.backtestId ? { backtestId: entry.metadata.backtestId } : {}),
      ...(entry.attachments?.length
        ? {
            attachments: entry.attachments.map((attachment) => ({
              path: `/work/uploads/${attachment.name}`,
              originalName: attachment.originalName,
            })),
          }
        : {}),
    }));

  return [
    'Conversation history (oldest to newest, including the current request):',
    JSON.stringify(messages, null, 2),
    '',
    'Treat the user turns as cumulative strategy requirements. A newer user turn overrides an older one only where they conflict; agent turns and system notes are context, not new requirements. An explicit BT-### reference is stronger: it selects that archived code/result state, so do not automatically reapply edits that exist only in later versions.',
  ];
}

/** Accepted result that a refinement must compare against rather than forget. */
function baselineBlock(session: Session, message: string): string[] {
  const referenced = referencedBacktests(session, message)[0];
  const result = referenced?.result ?? session.result;
  if (!result) return [];

  const name = referenced?.name ?? session.name;
  const period = referenced?.period ?? session.period;
  const id = referenced?.id ?? latestBacktest(session)?.id;

  return [
    referenced
      ? `User-selected baseline for this request: ${referenced.id}`
      : `Accepted baseline before this request${id ? `: ${id}` : ':'}`,
    `- Strategy: ${name || '(unnamed)'}`,
    `- Period: ${period.start} through ${period.end}`,
    `- Starting capital: ${result.startingCapital}`,
    `- Final value: ${result.finalValue}`,
    `- Total return: ${result.returnPct}%`,
    '- The accepted files are backed up at /work/baseline/strategy.py and /work/baseline/result.json.',
  ];
}

function backtestReferenceBlock(session: Session, message: string): string[] {
  const versions = referencedBacktests(session, message);
  if (versions.length === 0) return [];

  return [
    'Explicit backtest version references in this request:',
    ...versions.map(
      (version, index) =>
        `- ${version.id}${index === 0 ? ' (PRIMARY STARTING VERSION)' : ''}: ` +
        `${version.name || '(unnamed)'}, ${version.period.start} through ${version.period.end}, ` +
        `return ${version.result.returnPct}%, final value ${version.result.finalValue}. ` +
        `Exact files: /work/versions/${version.id}/strategy.py and /work/versions/${version.id}/result.json.`,
    ),
    `The server has already restored ${versions[0].id} into /work/strategy.py, /work/result.json, and /work/baseline/. Work from that exact version even if a later chat response exists. Additional referenced versions are comparison/material sources unless the user says otherwise.`,
  ];
}

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
    '     equityCurve: [[isoDate, value], …] (ascending),',
    '     positions: [[isoDate, {TICKER: weight, …}], …] (OPTIONAL — target weights HELD',
    '       as of each bar close; cash implied by sum < 1, negative = short; ≤ ~750 most recent bars),',
    '     benchmarkTicker, benchmarkReason, benchmark (or null),',
    '     code: <the strategy.py source>, period: {start, end}}',
    '- Reassess benchmarkTicker for this exact final strategy version: use the traded asset for a single-instrument timing strategy, a relevant liquid sector/index ETF for a focused basket, and a broad-market proxy only when no closer comparison is defensible. Add a brief benchmarkReason. Persist both in strategy.py/result.json so date-only reruns reproduce the choice; the server validates it independently.',
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
    const referenceLines = backtestReferenceBlock(session, text);
    return [
      'You are REFINING an existing backtest that already lives in /work.',
      '',
      ...conversationBlock(session),
      '',
      ...referenceLines,
      ...(referenceLines.length ? [''] : []),
      ...baselineBlock(session, text),
      '',
      'The selected baseline program is /work/strategy.py. Modify it to satisfy the change request below while preserving every non-conflicting requirement that applies to that version, then re-run it end-to-end and rewrite /work/result.json.',
      '',
      'Change request:',
      '"""',
      text || '(no text — the request is in the attached image(s))',
      '"""',
      ...attachmentBlock(attachments),
      '',
      'Refinement quality loop:',
      '- Read /work/strategy.py and /work/result.json before editing. Compare against the accepted baseline on the same dates, capital, cached data, costs, and fill assumptions.',
      '- When the user asks to improve, optimize, or make the strategy better, infer the requested metric from the conversation. If no metric is named, total return is the primary comparison; do not call a lower-return candidate an improvement merely because its rules sound more sophisticated.',
      '- If the user names a BT-### version, use its archived files and measured result exactly as directed. If the user compares against an unnamed earlier variant (for example, "the original"), recover that variant\'s reported result from the history and use it as an additional target; beating only the immediately previous, already-regressed run is not enough.',
      '- Run and measure the candidate. If it regresses on the requested objective, diagnose it and try other principled variants within this run instead of accepting the first attempt. Avoid brute-force parameter mining and lookahead.',
      '- If no defensible candidate improves the requested objective, restore /work/baseline/strategy.py and /work/baseline/result.json and say plainly that the accepted strategy was retained. An explicit request to improve risk, drawdown, or another metric may legitimately trade away total return, but quantify that trade-off.',
      '- Emit the agent summary for the FINAL accepted candidate only. State its metric beside the baseline and never claim an improvement that the numbers do not support.',
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
