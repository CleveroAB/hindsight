// ============================================================================
// Brainstorming — shaping an idea into a strategy before anything is backtested.
//
// A new strategy starts a run that takes minutes, so a half-formed idea is
// expensive to try. This is the cheap step before it: a short conversation in
// which the assistant asks what is missing and keeps a current draft of the
// strategy, which the person can then send to a real backtest.
//
// No run, no session, no files: one container, one answer (`HS_KIND=chat`, see
// docker/entrypoint.sh), on the same agent and credentials real runs use — the
// model's agent (Codex or Claude Code), at low effort, with no tools. The
// conversation lives with the client and is sent whole each turn. With the
// mock agent the answer is made here, so the UI works without a model.
// ============================================================================

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import type { IdeaMessage, IdeasReply } from '@/lib/types';
import { dockerUserArgs } from '@/lib/server/agent/dockerUser';
import { claudeTokenFile, providerOf } from '@/lib/server/models';

const DEFAULT_IMAGE = 'hindsight-agent:latest';
const DEFAULT_CODEX_HOME = '~/.codex';
/** A chat turn is one short answer; anything slower than this has gone wrong. */
const TIMEOUT_MS = 120_000;
/** Bounds on what a client may send: this is a chat, not a document store. */
export const MAX_IDEA_MESSAGES = 40;
export const MAX_IDEA_CHARS = 4000;

let counter = 0;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

export const IDEAS_SYSTEM = [
  'You are Hindsight, helping someone shape an investment idea into a strategy that can be backtested on historical market data. Nothing is traded and nothing runs during this conversation: you are only agreeing on what to test.',
  '',
  'How to help:',
  '- Work out what the idea needs to be testable: what is bought or sold (tickers, an index, a screen), the signal or rule, how often it rebalances, long-only or with shorts, the period, and the starting capital.',
  '- Offer concrete choices and sensible defaults instead of open questions. Ask at most one question per reply, and only when the answer changes the strategy.',
  '- Point out, briefly and plainly, what could make the test misleading: lookahead, survivorship bias, data that is hard to get, a period too short to mean anything.',
  '- You may suggest a variation worth comparing, but keep to the person\'s idea. Never promise returns or give personal financial advice.',
  '- Write for a phone: at most about 90 words, plain sentences, "- " bullets only when listing options. No headings, tables or links.',
  '',
  'Reply with ONE JSON object and nothing else, no code fence:',
  '{"reply": "<what you say to the person>", "strategy": "<the strategy so far>"}',
  '',
  '"strategy" is the idea as it stands, written as a single plain-English instruction someone could hand to a backtester: the instruments, the exact rules, the rebalance cadence, the period (for example "2010 to 2024") and the starting capital (default $10,000). Use defaults for anything not yet discussed and say in "reply" which ones you assumed. Keep it under 80 words. Use "" only when there is not yet enough to test anything.',
].join('\n');

/** The conversation as the one prompt a CLI takes. */
export function ideasPrompt(messages: IdeaMessage[]): string {
  const turns = messages.map((m) => `${m.role === 'user' ? 'Person' : 'Hindsight'}: ${m.text.trim()}`);
  return `The conversation so far:\n\n${turns.join('\n\n')}\n\nAnswer the person's last message with the JSON object.`;
}

/**
 * The assistant's answer from whatever text the model produced. A model that
 * wraps the object in a code fence or adds a sentence around it is still read;
 * one that answers in prose is taken as a reply with no draft. Pure — exported
 * for tests.
 */
export function parseIdeasAnswer(text: string): IdeasReply {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { reply?: unknown; strategy?: unknown };
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return {
          reply: parsed.reply.trim(),
          strategy: typeof parsed.strategy === 'string' ? parsed.strategy.trim() : '',
        };
      }
    } catch {
      // Not JSON after all: fall through and keep the words.
    }
  }
  return { reply: trimmed, strategy: '' };
}

/** A deterministic answer for the mock agent: echoes the idea back as a draft. */
function mockAnswer(messages: IdeaMessage[]): IdeasReply {
  const said = messages.filter((m) => m.role === 'user').map((m) => m.text.trim());
  const idea = said.join(' ').replace(/\s+/g, ' ').slice(0, 400);
  const hasPeriod = /\b(19|20)\d{2}\b/.test(idea);
  return {
    reply: hasPeriod
      ? 'That is enough to test. I assumed $10,000 to start and monthly rebalancing; change either and I will update the draft.'
      : 'Good start. I assumed 2015 to 2024, $10,000 to start and monthly rebalancing. Which period do you want to test?',
    strategy: `${idea}${hasPeriod ? '' : ' 2015 to 2024.'} $10,000 start, rebalanced monthly.`.trim(),
  };
}

function runChat(model: string, prompt: string): Promise<string> {
  const provider = providerOf(model);
  counter += 1;
  const cname = `hs-chat-${process.pid}-${counter}`;
  const image = process.env.HINDSIGHT_DOCKER_IMAGE || DEFAULT_IMAGE;
  const codexHome = expandHome(process.env.HINDSIGHT_CODEX_HOME || DEFAULT_CODEX_HOME);
  const args = [
    'run', '--rm', '--name', cname, ...dockerUserArgs(),
    '-e', 'HS_KIND=chat',
    '-e', `HS_PROVIDER=${provider}`,
    '-e', `HS_MODEL=${model}`,
    // Brainstorming wants a quick answer, whatever effort real runs use.
    '-e', 'HS_EFFORT=low',
    '-e', `HS_SYSTEM=${IDEAS_SYSTEM}`,
    '-e', `HS_PROMPT=${prompt}`,
    '-v', `${codexHome}:/codex-host:ro`,
    ...(provider === 'claude' ? ['-v', `${claudeTokenFile()}:/claude-host/token:ro`] : []),
    image,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      spawn('docker', ['kill', cname], { stdio: 'ignore' });
      reject(new Error('The model took too long to answer. Try again.'));
    }, TIMEOUT_MS);
    proc.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    proc.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the agent: ${e.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[ideas] ${provider} chat exited ${code}: ${(err || out).slice(-600)}`);
        reject(new Error('The model could not answer. Try again.'));
        return;
      }
      if (provider !== 'claude') {
        resolve(out);
        return;
      }
      // Claude Code's JSON envelope: the words are in `result`.
      try {
        const envelope = JSON.parse(out) as { result?: unknown; is_error?: unknown };
        if (envelope.is_error || typeof envelope.result !== 'string') {
          console.warn(`[ideas] claude chat failed: ${String(envelope.result).slice(0, 300)}`);
          reject(new Error('The model could not answer. Try again.'));
          return;
        }
        resolve(envelope.result);
      } catch {
        reject(new Error('The model could not answer. Try again.'));
      }
    });
  });
}

/** The assistant's next turn. Throws (human-readable) when no answer came. */
export async function brainstorm(messages: IdeaMessage[], model: string): Promise<IdeasReply> {
  if (process.env.HINDSIGHT_AGENT !== 'codex') return mockAnswer(messages);
  return parseIdeasAnswer(await runChat(model, ideasPrompt(messages)));
}
