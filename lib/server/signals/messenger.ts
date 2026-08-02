// ============================================================================
// Outbound signal messages. Default provider sends real iMessages through the
// macOS Messages app via `osascript` (argv passing — the phone and text are
// NEVER interpolated into the AppleScript source). Pluggable via env:
//   HINDSIGHT_SIGNAL_PROVIDER = imessage (default) | signal | poke | webhook
//   signal  — POST to a signal-cli-rest-api service (self-hosted, shared
//             across projects) at HINDSIGHT_SIGNAL_CLI_URL: the message
//             arrives on Signal FROM a dedicated bot number
//             (HINDSIGHT_SIGNAL_SENDER), so it lands as a real conversation
//             with notifications. Optional HINDSIGHT_SIGNAL_CLI_AUTH is sent
//             as the Authorization header for proxied deployments. Run the
//             service in json-rpc mode so receiving is continuous; see
//             PROTOCOL.md §8 for setup.
//   poke    — POST to Poke.com's inbound webhook with HINDSIGHT_POKE_API_KEY
//   webhook — POST { phone, message } to HINDSIGHT_SIGNAL_WEBHOOK_URL (covers
//             OpenClaw/Hermes-style iMessage bridges)
// Caveat on `imessage`: macOS sends as the signed-in Apple ID, so messages to
// your OWN number land in the self-thread WITHOUT notifications (and macOS 26
// broke the AppleScript send verb outright). Prefer `signal`.
// The compose* helpers are pure and unit-testable; keep the copy short.
// ============================================================================

import { execFile } from 'node:child_process';
import type { SignalUpdate, StrategyActivation } from '@/lib/types';
import { MINUS, formatMoney, formatSignedPercent } from '@/lib/format';

const IMESSAGE_TIMEOUT_MS = 15_000;
const HTTP_TIMEOUT_MS = 10_000;
const POKE_URL = 'https://poke.com/api/v1/inbound-sms/webhook';

// `on run argv` receives [phone, text] as proper arguments, so arbitrary
// message content can't break out of (or into) the script.
const IMESSAGE_SCRIPT = [
  'on run argv',
  '  tell application "Messages"',
  '    set svc to 1st account whose service type = iMessage',
  '    send (item 2 of argv) to participant (item 1 of argv) of svc',
  '  end tell',
  'end run',
].join('\n');

function sendViaIMessage(phone: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-e', IMESSAGE_SCRIPT, phone, text],
      { timeout: IMESSAGE_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const detail = stderr?.trim() || err.message;
        reject(new Error(`iMessage send failed: ${detail}`));
      },
    );
  });
}

async function sendViaPoke(text: string): Promise<void> {
  const key = process.env.HINDSIGHT_POKE_API_KEY?.trim();
  if (!key) throw new Error('HINDSIGHT_SIGNAL_PROVIDER=poke requires HINDSIGHT_POKE_API_KEY.');
  const res = await fetch(POKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ message: text }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Poke webhook refused the message (HTTP ${res.status}).`);
}

// Signal delivery is a network round-trip through signal-cli's JVM on a
// remote host — first sends after a quiet period can take well over 10s.
const SIGNAL_TIMEOUT_MS = 30_000;

async function sendViaSignal(phone: string, text: string): Promise<void> {
  const base = process.env.HINDSIGHT_SIGNAL_CLI_URL?.trim().replace(/\/+$/, '');
  if (!base) throw new Error('HINDSIGHT_SIGNAL_PROVIDER=signal requires HINDSIGHT_SIGNAL_CLI_URL.');
  const sender = normalizePhone(process.env.HINDSIGHT_SIGNAL_SENDER);
  if (!sender) {
    throw new Error(
      'HINDSIGHT_SIGNAL_PROVIDER=signal requires HINDSIGHT_SIGNAL_SENDER (the bot number, E.164).',
    );
  }
  const auth = process.env.HINDSIGHT_SIGNAL_CLI_AUTH?.trim();
  const res = await fetch(`${base}/v2/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ number: sender, recipients: [phone], message: text }),
    signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    // signal-cli-rest-api returns { error: "..." } bodies; surface the useful
    // part but never dump a whole HTML error page into session state.
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') detail = ` — ${body.error.slice(0, 160)}`;
    } catch {
      /* non-JSON body; the status alone will have to do */
    }
    throw new Error(`Signal send failed (HTTP ${res.status})${detail}`);
  }
}

async function sendViaWebhook(phone: string, text: string): Promise<void> {
  const url = process.env.HINDSIGHT_SIGNAL_WEBHOOK_URL?.trim();
  if (!url) throw new Error('HINDSIGHT_SIGNAL_PROVIDER=webhook requires HINDSIGHT_SIGNAL_WEBHOOK_URL.');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, message: text }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Signal webhook refused the message (HTTP ${res.status}).`);
}

/** `+46 72-743 71 56` → `+46727437156`; null unless the result is valid E.164. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const phone = (raw ?? '').replace(/[\s-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

/** The outbound provider after env normalization — anything unknown means imessage. */
export function signalProvider(): 'imessage' | 'signal' | 'poke' | 'webhook' {
  const provider = process.env.HINDSIGHT_SIGNAL_PROVIDER?.trim().toLowerCase();
  return provider === 'signal' || provider === 'poke' || provider === 'webhook'
    ? provider
    : 'imessage';
}

/** Deliver one message to `phone` via the configured provider. Throws on failure. */
export async function sendSignalMessage(phone: string, text: string): Promise<void> {
  const provider = signalProvider();
  if (provider === 'signal') return sendViaSignal(phone, text);
  if (provider === 'poke') return sendViaPoke(text);
  if (provider === 'webhook') return sendViaWebhook(phone, text);
  return sendViaIMessage(phone, text);
}

// ---------------------------------------------------------------------------
// Message composers — pure functions, no I/O. Every message leads with
// "Hindsight" so the thread is recognizable; times render in the user's home
// timezone (Europe/Stockholm).
// ---------------------------------------------------------------------------

const HOME_TZ = 'Europe/Stockholm';

/** `Mon 3 Aug, 22:20` in Europe/Stockholm. */
function formatCheckTime(epochMs: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: HOME_TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

/** `"Inverse Cramer"`, or a neutral label when the session has no name yet. */
function strategyLabel(name: string): string {
  return name.trim() ? `"${name.trim()}"` : 'your strategy';
}

/** A weight as a whole percent with a proper minus for shorts: `70%`, `−30%`. */
function pctWeight(weight: number): string {
  return `${weight < 0 ? MINUS : ''}${Math.round(Math.abs(weight) * 100)}%`;
}

/** `Portfolio −0.8% on the 2026-08-01 bar.` — omitted when not computable. */
function dayMoveLine(update: SignalUpdate): string {
  if (update.dayChangePct === null) return '';
  return ` Portfolio ${formatSignedPercent(update.dayChangePct)} on the ${update.date} bar.`;
}

/** One line per change: `BUY QQQ 30% → 70%`. */
function changeLines(changes: SignalUpdate['changes']): string {
  return changes
    .map((c) => `${c.action} ${c.ticker} ${pctWeight(c.from)} → ${pctWeight(c.to)}`)
    .join('\n');
}

/** `SPY 70%, TLT 30%` (+ implied cash), or `all cash` for an empty book. */
function holdingsSummary(weights: Record<string, number>): string {
  const entries = Object.entries(weights);
  if (entries.length === 0) return 'all cash';
  const parts = entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([ticker, weight]) => `${ticker} ${pctWeight(weight)}`);
  const invested = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (invested < 0.995) parts.push(`cash ${pctWeight(1 - invested)}`);
  return parts.join(', ');
}

const INFERRED_NOTE =
  ' This strategy was saved before position tracking — send it any refinement in Hindsight and it will start reporting exact holdings.';

/** Confirmation sent when a strategy is activated. */
export function composeActivationMessage(name: string, activation: StrategyActivation): string {
  return (
    `Hindsight: ${strategyLabel(name)} is now active. ${activation.cadenceReason}. ` +
    `First check ${formatCheckTime(activation.nextCheckAt)}.`
  );
}

/** Confirmation sent when a strategy is deactivated. */
export function composeDeactivationMessage(name: string): string {
  return `Hindsight: ${strategyLabel(name)} is deactivated — no more signal checks.`;
}

/**
 * Sent to the number LOSING a strategy's signals when a re-activation moves
 * them elsewhere — a silent redirect must never be undetectable from the old
 * phone.
 */
export function composeDestinationChangedMessage(name: string, next: string): string {
  return (
    `Hindsight: signal updates for ${strategyLabel(name)} now go to ${next} — this number will ` +
    `stop receiving them. If that wasn't you, open Hindsight and deactivate the strategy.`
  );
}

/** Manual "Check now" outcome when no new bar has closed — still a delivery proof. */
export function composeNoNewBarMessage(name: string, last: SignalUpdate | null): string {
  const still = last && !last.inferred && last.changes.length === 0 ? ' — still HOLD' : '';
  return `Hindsight — ${strategyLabel(name)}: manual check done, no new bar since ${last?.date ?? 'the last check'}${still}.`;
}

/** BUY/SELL update (or explicit HOLD) for one checked bar. */
export function composeSignalMessage(name: string, update: SignalUpdate): string {
  if (update.inferred) {
    return (
      `Hindsight — ${strategyLabel(name)}, ${update.date}: checked, no position data.` +
      dayMoveLine(update) +
      INFERRED_NOTE
    );
  }
  if (update.changes.length === 0) {
    return `Hindsight — ${strategyLabel(name)}, ${update.date}: HOLD, no position changes.` + dayMoveLine(update);
  }
  return `Hindsight — ${strategyLabel(name)}, ${update.date}:\n${changeLines(update.changes)}.` + dayMoveLine(update);
}

/** First check after activation — confirms the schedule works + current book. */
export function composeFirstCheckMessage(
  name: string,
  update: SignalUpdate,
  holdings: Record<string, number> | null,
  latestValue: number | null,
): string {
  const value = latestValue !== null ? ` Portfolio value ${formatMoney(latestValue)}.` : '';
  if (holdings === null) {
    return (
      `Hindsight: first check for ${strategyLabel(name)} done (${update.date}).${value}` + INFERRED_NOTE
    );
  }
  return (
    `Hindsight: first check for ${strategyLabel(name)} done (${update.date}). ` +
    `Currently holding ${holdingsSummary(holdings)}.${value} You'll get a message when positions change.`
  );
}

/** Sent once when checks START failing (null → error transition only). */
export function composeErrorMessage(name: string, error: string): string {
  const detail = error.trim().replace(/\s+/g, ' ').slice(0, 200);
  return `Hindsight: the signal check for ${strategyLabel(name)} failed — ${detail} Checks continue on schedule.`;
}
