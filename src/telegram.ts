import type { Diff } from './extract.ts';
import { summarise } from './extract.ts';

/** Ica opens every message this way. */
export const GREETING = process.env.WATCHER_GREETING ?? 'Doot Doot.';
const LIMIT = 4000; // Telegram allows 4096 characters per message.
const PER_SECTION = 10;

export const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url: string, text: string) => `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(text)}</a>`;

function section(title: string, lines: string[]) {
  if (!lines.length) return [];
  const shown = lines.slice(0, PER_SECTION);
  return [`\n<b>${title}</b>`, ...shown, ...(lines.length > shown.length ? [`…and ${lines.length - shown.length} more`] : [])];
}

function fit(lines: string[]) {
  let text = lines.join('\n');
  while (text.length > LIMIT && lines.length > 3) { lines.splice(lines.length - 2, 1); text = lines.join('\n'); }
  return text.length > LIMIT ? text.slice(0, LIMIT - 1) + '…' : text;
}

export function changeMessage(label: string, url: string, diff: Diff) {
  return fit([
    GREETING,
    `<b>${escapeHtml(label)}</b> changed: ${escapeHtml(summarise(diff))}.`,
    ...section('New', diff.added.map(item => '• ' + escapeHtml(item))),
    ...section('Changed', diff.changed.map(({ before, after }) => `• ${escapeHtml(after)}\n   <i>was: ${escapeHtml(before)}</i>`)),
    ...section('Gone', diff.removed.map(item => '• ' + escapeHtml(item))),
    '',
    link(url, 'Open the page'),
  ]);
}

export function baselineMessage(label: string, url: string, count: number, selector: string) {
  const what = selector ? `${count} ${count === 1 ? 'item matches' : 'items match'} <code>${escapeHtml(selector)}</code>` : `the page has ${count} lines of text`;
  return [GREETING, `Now watching <b>${escapeHtml(label)}</b>: ${what} right now. I'll message you when that changes.`, link(url, 'Open the page')].join('\n');
}

export function problemMessage(label: string, url: string, problem: string) {
  return [GREETING, `I can't check <b>${escapeHtml(label)}</b>: ${escapeHtml(problem)}. I'll keep trying less often and tell you when it works again.`, link(url, 'Open the page')].join('\n');
}

export function recoveredMessage(label: string, url: string) {
  return [GREETING, `<b>${escapeHtml(label)}</b> is reachable again. Back to watching.`, link(url, 'Open the page')].join('\n');
}

export function testMessage(count: number) {
  return `${GREETING}\nIca is connected to Voracity. ${count === 1 ? '1 site is' : `${count} sites are`} being watched.`;
}

/** Send one message. Telegram rate limits (429) are retried once after retry_after. */
export async function sendTelegram(token: string, chatId: string, text: string, fetcher: typeof fetch = fetch) {
  const base = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  const send = () => fetcher(`${base}/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  });
  let response = await send();
  if (response.status === 429) {
    const body = await response.json().catch(() => ({})) as { parameters?: { retry_after?: number } };
    await new Promise(resolve => setTimeout(resolve, Math.min(30, body.parameters?.retry_after ?? 5) * 1000));
    response = await send();
  }
  if (!response.ok) throw new Error(`Telegram returned HTTP ${response.status}`);
}
