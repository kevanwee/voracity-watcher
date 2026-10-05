import type { Diff } from './extract.ts';
import { summarise } from './extract.ts';
import { classify, formatPrice, formatStock, headline, type Insight, type Listing, type Move } from './insight.ts';

/** Ica opens every message this way. */
export const GREETING = process.env.WATCHER_GREETING ?? 'Doot Doot.';
const LIMIT = 4000; // Telegram allows 4096 characters per message.

export const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url: string, text: string) => `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(text)}</a>`;

function fit(lines: string[]) {
  let text = lines.join('\n');
  while (text.length > LIMIT && lines.length > 3) { lines.splice(lines.length - 2, 1); text = lines.join('\n'); }
  return text.length > LIMIT ? text.slice(0, LIMIT - 1) + '…' : text;
}

/** How many entries each highlight group shows before "…and N more". */
const PER_GROUP = 5;
const stockMark = (stock: Listing['stock']) => (stock === 0 ? '×' : stock === 'in' ? '✓' : String(stock ?? '?'));

/**
 * A change alert: a one-line summary, what matters (sold out, back in stock, new, price
 * moves, then stock counts on one line), and the full before → after list folded away in
 * an expandable quote. `names` holds English names for Japanese ones, when translated.
 */
export function changeMessage(label: string, url: string, diff: Diff, names: Record<string, string> = {}) {
  const insight = classify(diff);
  const name = (listing: Listing) => escapeHtml(names[listing.name] ?? listing.name);
  const price = (listing: Listing) => (listing.price ? ` · ${formatPrice(listing.price)}` : '');
  const lines = [GREETING, `<b>${escapeHtml(label)}</b>: ${escapeHtml(headline(insight) || summarise(diff))}.`];
  const group = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push('', `<b>${title}</b>`, ...items.slice(0, PER_GROUP).map(item => `• ${item}`), ...(items.length > PER_GROUP ? [`…and ${items.length - PER_GROUP} more`] : []));
  };
  group('🔴 Sold out', insight.soldOut.map(m => `${name(m.after)}${price(m.after)}`));
  group('🟢 Back in stock', insight.restocked.map(m => `${name(m.after)} · ${formatStock(m.after.stock)}${price(m.after)}`));
  group('✨ New', insight.added.map(l => `${name(l)}${price(l)}${l.stock !== undefined ? ` · ${formatStock(l.stock)}` : ''}`));
  group('💸 Price down', insight.priceDown.map(m => `${name(m.after)}: ${formatPrice(m.before.price)} → <b>${formatPrice(m.after.price)}</b>`));
  group('📈 Price up', insight.priceUp.map(m => `${name(m.after)}: ${formatPrice(m.before.price)} → <b>${formatPrice(m.after.price)}</b>`));
  if (insight.stock.length) {
    const shown = insight.stock.slice(0, 6).map(m => `${name(m.after)} ${stockMark(m.before.stock)}→${stockMark(m.after.stock)}`);
    lines.push('', `📦 <b>Stock</b>: ${shown.join(' · ')}${insight.stock.length > shown.length ? ` · +${insight.stock.length - shown.length} more` : ''}`);
  }
  group('✏️ Changed', insight.other.map(m => name(m.after)));
  group('👋 Gone', insight.removed.map(l => name(l)));

  // The full list, folded: every entry with what changed, and the original name when translated.
  const tail = ['', link(url, 'Open the page')];
  const full = fullList(insight, names);
  let budget = LIMIT - [...lines, ...tail].join('\n').length - 80;
  const kept: string[] = [];
  for (const line of full) { if (line.length + 1 > budget) break; kept.push(line); budget -= line.length + 1; }
  if (kept.length) {
    if (kept.length < full.length) kept.push(`…and ${full.length - kept.length} more on the page`);
    lines.push('', `<blockquote expandable><b>Full list</b>\n${kept.join('\n')}</blockquote>`);
  }
  return fit([...lines, ...tail]);
}

function fullList(insight: Insight, names: Record<string, string>) {
  const label = (l: Listing) => {
    const english = names[l.name];
    return `${l.code ? `${escapeHtml(l.code)} ` : ''}${escapeHtml(english ?? l.name)}${english ? ` <i>(${escapeHtml(l.name)})</i>` : ''}`;
  };
  const what = ({ before, after }: Move) => {
    const priceMoved = !!before.price && !!after.price && before.price.amount !== after.price.amount;
    const parts: string[] = [];
    if (priceMoved) parts.push(`${formatPrice(before.price)} → ${formatPrice(after.price)}`);
    if (before.stock !== after.stock) parts.push(`stock ${stockMark(before.stock)} → ${stockMark(after.stock)}`);
    if (!parts.length) return `was: ${escapeHtml(before.raw)}`;
    if (!priceMoved && after.price) parts.unshift(formatPrice(after.price));
    return parts.join(', ');
  };
  return [
    ...[...insight.soldOut, ...insight.restocked, ...insight.priceDown, ...insight.priceUp, ...insight.stock, ...insight.other].map(m => `• ${label(m.after)}: ${what(m)}`),
    ...insight.added.map(l => `• ${label(l)}: new${l.price ? `, ${formatPrice(l.price)}` : ''}${l.stock !== undefined ? `, ${formatStock(l.stock)}` : ''}`),
    ...insight.removed.map(l => `• ${label(l)}: gone`),
  ];
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

export function testMessage(count: number, runner: 'cloud' | 'local' = 'cloud') {
  return `${GREETING}\nIca is connected to Voracity${runner === 'local' ? ' from your PC' : ''}. ${count === 1 ? '1 site is' : `${count} sites are`} being watched.`;
}

export function handoffMessage(label: string, url: string, status: number) {
  return [GREETING, `<b>${escapeHtml(label)}</b> refuses GitHub's servers (HTTP ${status}), so your PC checks it from now on. GitHub won't contact this site again.`, link(url, 'Open the page')].join('\n');
}

/** Call a Bot API method. Telegram rate limits (429) are retried once after retry_after. */
export async function telegramCall(token: string, method: string, payload: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  const base = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  const send = () => fetcher(`${base}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000), body: JSON.stringify(payload),
  });
  let response = await send();
  if (response.status === 429) {
    const body = await response.json().catch(() => ({})) as { parameters?: { retry_after?: number } };
    await new Promise(resolve => setTimeout(resolve, Math.min(30, body.parameters?.retry_after ?? 5) * 1000));
    response = await send();
  }
  const result = await response.clone().json().catch(() => null) as { ok?: boolean; error_code?: number; description?: string } | null;
  // Replaying an already-applied edit is success. Match this specific API
  // error narrowly; other edit/send failures must keep the relay delivery pending.
  if (method === 'editMessageText' && response.status === 400 && result?.error_code === 400
    && typeof result.description === 'string' && /^Bad Request: message is not modified(?::|$)/.test(result.description)) return response;
  if (!response.ok || result?.ok !== true) throw new Error(`Telegram request failed (HTTP ${response.status})`);
  return response;
}

/** Send one HTML message, optionally with inline buttons. */
export async function sendTelegram(token: string, chatId: string, text: string, fetcher: typeof fetch = fetch, buttons?: { text: string; data: string }[][]) {
  await telegramCall(token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    ...(buttons ? { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) } } : {}),
  }, fetcher);
}
