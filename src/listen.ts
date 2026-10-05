// Ica's Telegram side. On the owner's PC this is a long-running listener that also runs
// the 5-minute schedule, all through one queue so a requested check never overlaps a
// scheduled one. When the PC is off, the cloud runner reads pending messages instead
// (mode 'cloud'), so quick capture still works from a phone.
import { answerQuestion } from './agent.ts';
import { localModel, type LocalModel } from './local-model.ts';
import { localClock, settingsFrom, type AssistantSettings, type Bookmark } from './assistant.ts';
import { formatDue, parseCapture, type Proposal } from './capture.ts';
import { changeButtonLabel, changeQuestion, changeResultText, isChange, parseEdit, planEdit, type Change, type EditStore } from './edit.ts';
import { GREETING, escapeHtml, sendTelegram, telegramCall } from './telegram.ts';
import { PARCELS_ARCHIVED_REPLY, PARCELS_ENABLED, parcelsReply, type Parcel, type ParcelState } from './parcels.ts';
import { ownerTranslator } from './translate.ts';
import { claimUpdate, finishClaim, relayStatus, RELAY_RENEW_MS, type Relay } from './relay.ts';
import { deliveryIdentity, type DeliveryIdentity, type DeliveryStore, type OfferedDelivery } from './deliveries.ts';
import { routeOf, runOnce, type Deps, type Outcome, type Store, type Watch, type WatchState } from './run.ts';

export const SCHEDULE_MS = 5 * 60_000;
/** Check commands sent while the PC was off are not run late; Ica says so instead. */
export const STALE_COMMAND_S = 10 * 60;
/** Unconfirmed proposals are forgotten after a day (Telegram also keeps updates for 24 h). */
export { PROPOSAL_TTL_MS } from './confirmations.ts';

export const COMMANDS = [
  { command: 'check', description: 'Check your PC watches now (add a name to check one)' },
  { command: 'status', description: 'Show each watch and its last check' },
  { command: 'track', description: 'Track a parcel, e.g. /track SPXSG012345678901 keyboard' },
  { command: 'parcels', description: 'Show your parcels and where they are' },
  { command: 'remind', description: 'Add a reminder, e.g. /remind file the brief Friday' },
  { command: 'note', description: 'Add a note to My Space' },
  { command: 'save', description: 'Add a link to your reading list' },
  { command: 'done', description: 'Mark a reminder done, e.g. /done file the brief' },
  { command: 'move', description: 'Change a due date, e.g. /move file the brief to Monday' },
  { command: 'delete', description: 'Delete a card from My Space' },
  { command: 'help', description: 'What Ica can do' },
];

export interface Update {
  update_id: number;
  message?: { date: number; text?: string; chat: { id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

export type Command = { name: 'check'; filter: string } | { name: 'status' } | { name: 'parcels' } | { name: 'help' } | null;

/** Accepts "/check", "/check@SomeBot ex13", "check ex13", "status", "/help", "/start". */
export function parseCommand(text: string | undefined): Command {
  const match = text?.trim().match(/^\/?([a-z]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase(), rest = (match[2] ?? '').trim();
  if (name === 'check') return { name: 'check', filter: rest };
  if (name === 'status' && !rest) return { name: 'status' };
  if (name === 'parcels' && !rest) return { name: 'parcels' };
  if ((name === 'help' || name === 'start') && !rest) return { name: 'help' };
  return null;
}

const ago = (ms: number, now: number) => {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

export function helpReply() {
  return [GREETING, 'I watch your sites, send your morning briefing and keep your reminders.',
    '',
    '<b>Add things</b> (I ask before saving)',
    '“remind me to file the brief Friday”',
    '“note: book the venue”',
    'a link on its own, or /save &lt;link&gt;: reading list',
    '',
    '<b>Change things</b> (I ask first)',
    '/done &lt;reminder&gt;, /move &lt;reminder&gt; to &lt;day&gt;, /delete &lt;card&gt;',
    '',
    '<b>Ask me anything</b> (uses the AI on your PC)',
    '“what’s due before my exam?”, “what’s on tomorrow?”, “move the brief to Monday”',
    '',
    '<b>Watches</b>',
    '/check: check your PC watches now (/check &lt;name&gt; for one)',
    '/status: each watch and its last check'].join('\n');
}

const OUTCOME_LABEL: Record<Outcome['kind'], string> = { changed: '🆕', unchanged: '✓', baseline: '👀', failed: '⚠️', moved: '↪', waiting: '⏳' };

export function checkReply(outcomes: Outcome[], cloudLabels: string[], filter: string) {
  const lines = [GREETING];
  if (!outcomes.length) lines.push(filter ? `No watch on your PC matches “${escapeHtml(filter)}”.` : 'You have no active watches on your PC.');
  else {
    lines.push(`Checked ${outcomes.filter(o => o.kind !== 'waiting').length} of ${outcomes.length}:`);
    for (const outcome of outcomes) lines.push(`${OUTCOME_LABEL[outcome.kind]} <b>${escapeHtml(outcome.label)}</b>: ${escapeHtml(outcome.detail)}${outcome.kind === 'changed' ? ' (details above)' : ''}`);
  }
  if (cloudLabels.length) lines.push(`\nGitHub checks ${cloudLabels.map(label => `<b>${escapeHtml(label)}</b>`).join(', ')} on its own schedule; /status shows its last check.`);
  return lines.join('\n');
}

function watchLine(watch: Watch, state: WatchState | undefined, now: number) {
  const where = routeOf(state, watch) === 'local' ? 'your PC' : 'GitHub';
  const last = !state ? 'not checked yet'
    : state.status === 'error' ? `check failed ${ago(state.checkedAt, now)}: ${state.error ?? 'unknown error'}`
    : `checked ${ago(state.checkedAt, now)}, ${state.itemCount ?? 0} items${state.changedAt ? `; changed ${ago(state.changedAt, now)}${state.summary ? ` (${state.summary})` : ''}` : ''}`;
  return `• <b>${escapeHtml(watch.label)}</b>${watch.enabled ? '' : ' (paused)'}, from ${where}: ${escapeHtml(last)}`;
}

export function statusReply(watches: Watch[], states: Map<string, WatchState>, now: number) {
  if (!watches.length) return `${GREETING}\nNo watches yet. Add one in Voracity's Site watcher.`;
  return [GREETING, ...watches.map(watch => watchLine(watch, states.get(watch.id), now))].join('\n');
}

/**
 * /check while the PC is away. The cloud run checks its own watches just before it reads
 * messages, so their results are seconds old; fetching again would only hit the sites twice.
 * Watches on the PC wait for it.
 */
export function cloudCheckReply(watches: Watch[], states: Map<string, WatchState>, now: number, filter: string) {
  const lines = [GREETING];
  const cloud = watches.filter(watch => routeOf(states.get(watch.id), watch) === 'cloud');
  const pc = watches.filter(watch => routeOf(states.get(watch.id), watch) === 'local');
  if (!watches.length) lines.push(filter ? `No active watch matches “${escapeHtml(filter)}”.` : 'You have no active watches.');
  if (cloud.length) lines.push('GitHub just checked these:', ...cloud.map(watch => watchLine(watch, states.get(watch.id), now)));
  if (pc.length) lines.push(`${cloud.length ? '\n' : ''}Your PC is off or asleep, so ${pc.map(watch => `<b>${escapeHtml(watch.label)}</b>`).join(', ')} ${pc.length === 1 ? 'waits' : 'wait'} until it's back.`);
  return lines.join('\n');
}

export function proposalText(p: Proposal, today: string) {
  if (p.kind === 'parcel') return `${GREETING}\nTrack this parcel?\n<b>${escapeHtml(p.label)}</b>\n<code>${escapeHtml(p.number)}</code>`;
  if (p.kind === 'bookmark') return `${GREETING}\nAdd to your reading list?\n<b>${escapeHtml(p.title)}</b>\n${escapeHtml(p.url)}`;
  const body = p.body ? `\n${escapeHtml(p.body.length > 200 ? p.body.slice(0, 199) + '…' : p.body)}` : '';
  if (p.kind === 'note') return `${GREETING}\nSave this note to My Space?\n<b>${escapeHtml(p.title)}</b>${body}`;
  return `${GREETING}\nSave this reminder?\n<b>${escapeHtml(p.title)}</b>${body}\nDue: ${formatDue(p.dueDate, today)}`;
}

function savedText(p: Proposal, today: string) {
  if (p.kind === 'parcel') return `Tracking ✓\n<b>${escapeHtml(p.label)}</b>. I'll message you when it moves.`;
  if (p.kind === 'bookmark') return `Added to your reading list ✓\n<b>${escapeHtml(p.title)}</b>`;
  if (p.kind === 'note') return `Saved to My Space ✓\n<b>${escapeHtml(p.title)}</b>`;
  return `Saved to My Space ✓\n<b>${escapeHtml(p.title)}</b>, due ${formatDue(p.dueDate, today)}`;
}

export { cardFor, bookmarkFor } from './confirmations.ts';
export type { Pending } from './confirmations.ts';
import { callbackFor, parseDecision, proposalsFor, type ConfirmationStore, type cardFor, type bookmarkFor } from './confirmations.ts';
export type NewCard = ReturnType<typeof cardFor>;
export type NewBookmark = ReturnType<typeof bookmarkFor>;
export interface CaptureStore extends EditStore, ConfirmationStore, DeliveryStore {
  settings(uid: string): Promise<Partial<AssistantSettings> | null>;
  unreadBookmarks(uid: string): Promise<Bookmark[]>;
  parcels(uid: string): Promise<Parcel[]>;
  parcelStates(uid: string): Promise<Map<string, ParcelState>>;
  createParcel(uid: string, parcel: Parcel): Promise<void>;
}

export interface ListenDeps {
  /** Overrides PARCELS_ENABLED (tests). */
  parcelsEnabled?: boolean;
  token: string;
  ollama?: LocalModel;
  owners: Record<string, string>;
  store: Store & CaptureStore;
  base: Omit<Deps, 'owners' | 'store' | 'send' | 'runner' | 'manual' | 'test'>;
  /** 'local' (the PC listener, default) can run /check and questions; 'cloud' answers while the PC is off. */
  mode?: 'local' | 'cloud';
  /** Private iCal feed URLs per owner (WATCHER_CALENDARS). */
  calendars?: Record<string, string[]>;
  /** The Telegram relay (WATCHER_RELAY): when set, messages come from it instead of getUpdates. */
  relay?: Relay | null;
  fetcher?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

/** Serialises every run so schedule and commands never overlap. */
export function makeQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
}

export function makeHandler(deps: ListenDeps, enqueue: ReturnType<typeof makeQueue>) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const send = (chatId: string, text: string, buttons?: { text: string; data: string }[][]) => sendTelegram(deps.token, chatId, text, deps.fetcher, buttons);
  const call = (method: string, payload: Record<string, unknown>) => telegramCall(deps.token, method, payload, deps.fetcher);
  const ownerByChat = new Map(Object.entries(deps.owners).map(([uid, chat]) => [chat, uid]));
  const today = async (uid: string) => localClock(now(), settingsFrom(await deps.store.settings(uid)).timezone).date;
  let checking = false;

  async function confirm(update: NonNullable<Update['callback_query']>) {
    const chatId = String(update.message?.chat.id ?? ''), uid = ownerByChat.get(chatId);
    if (!uid || !update.message) return;
    const [action, id, revision] = (update.data ?? '').split(':');
    const edit = (text: string) => call('editMessageText', { chat_id: chatId, message_id: update.message!.message_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (action === 'done' && /^done:[a-zA-Z0-9_-]{1,100}:\d+$/.test(update.data ?? '') && Number.isSafeInteger(Number(revision))) {
      // One-tap "✓" from the briefing or a reminder alert: an explicit action, still revision-checked.
      const card = (await deps.store.cards(uid)).find(c => c.id === id);
      const result = !card || card.kind !== 'reminder' ? 'missing' : card.done ? 'ok' : await deps.store.updateCard(uid, id, Number(revision), { done: true }, now());
      const title = card?.title ?? 'That reminder';
      const toast = result === 'ok' ? `✓ ${title} is done` : result === 'missing' ? `${title} no longer exists` : `${title} changed elsewhere; send /done to try again`;
      await call('answerCallbackQuery', { callback_query_id: update.id, text: toast.slice(0, 190) }).catch(() => undefined);
      log(`reminder done from button: ${result}`);
      return;
    }
    const decision = parseDecision(update.data ?? '');
    await call('answerCallbackQuery', { callback_query_id: update.id }).catch(() => undefined);
    if (!decision) {
      await edit(`${GREETING}\nThat confirmation is no longer valid. Send the request again.`);
      return;
    }
    const result = await deps.store.decideProposal(uid, decision, now(), deps.parcelsEnabled ?? PARCELS_ENABLED);
    const date = await today(uid);
    const p = result.proposal;
    const text = result.status === 'cancelled' ? `${GREETING}\nOK, I left it as it is.`
      : result.status === 'expired' ? `${GREETING}\nThat one expired or was already handled. Send it again if you still want it.`
      : result.status === 'invalid' ? `${GREETING}\nThat proposal changed or is invalid. Send the request again.`
      : result.status === 'disabled' ? PARCELS_ARCHIVED_REPLY
      : result.status === 'duplicate' && p?.kind === 'parcel' ? `${GREETING}\nYou're already tracking <code>${escapeHtml(p.number)}</code>. /parcels shows its status.`
      : p && isChange(p) ? changeResultText(p, result.status === 'saved' ? 'ok' : result.status as 'missing' | 'conflict', date)
      : p ? `${GREETING}\n${savedText(p as Proposal, date)}` : `${GREETING}\nThat request could not be completed.`;
    // This notification is deliberately outside the transaction. If it fails,
    // retrying the callback returns the recorded result without another effect.
    await edit(text);
    log(`confirmation: ${result.status}`);
  }

  async function offer(uid: string, chatId: string, items: (Proposal | Change)[], date: string, together: boolean, identity: DeliveryIdentity, answer?: string) {
    const at = now();
    const saved = await deps.store.rememberOffer(uid, { identity, at, entries: proposalsFor(uid, items, at, together), date, together, ...(answer ? { answer } : {}) }, at);
    await sendOffer(chatId, saved);
  }

  async function sendOffer(chatId: string, saved: OfferedDelivery) {
    const { entries, date, together } = saved;
    if (saved.answer) await send(chatId, `${GREETING}\n${saved.answer}`);
    const items = Object.values(entries).map(p => p.action);
    const offered = Object.entries(entries);
    if (together && items.length > 1) {
      await send(chatId, changeQuestion(items as Change[], date), [
        ...offered.map(([id, p]) => [{ text: changeButtonLabel(p.action as Change), data: callbackFor('save', id, p) }]),
        [{ text: 'Cancel', data: callbackFor('cancel', offered[0][0], offered[0][1]) }],
      ]);
      return;
    }
    for (const [id, p] of offered) {
      const item = p.action;
      const text = isChange(item) ? changeQuestion([item], date) : proposalText(item, date);
      const yes = isChange(item) ? (item.kind === 'delete' ? 'Delete' : item.kind === 'complete' ? 'Mark done' : 'Update') : 'Save';
      await send(chatId, text, [[{ text: yes, data: callbackFor('save', id, p) }, { text: 'Cancel', data: callbackFor('cancel', id, p) }]]);
    }
  }

  let thinking = false;

  return async function handle(update: Update) {
    if (update.callback_query) { await confirm(update.callback_query); return; }
    const message = update.message;
    if (!message) return;
    const chatId = String(message.chat.id), uid = ownerByChat.get(chatId);
    if (!uid) return; // Only owners in WATCHER_OWNERS can talk to Ica; everyone else is ignored.
    const identity = deliveryIdentity(update);
    const prior = await deps.store.offered(uid, identity, now());
    if (prior) { await sendOffer(chatId, prior); return; }
    const command = parseCommand(message.text);
    if (command?.name === 'help') { await send(chatId, helpReply()); return; }
    const parcelsOn = deps.parcelsEnabled ?? PARCELS_ENABLED;
    if (command?.name === 'parcels' && !parcelsOn) { await send(chatId, PARCELS_ARCHIVED_REPLY); return; }
    if (command?.name === 'parcels') {
      const [parcels, states] = await Promise.all([deps.store.parcels(uid), deps.store.parcelStates(uid)]);
      await send(chatId, parcelsReply(parcels, states));
      return;
    }
    if (command?.name === 'status') {
      const [watches, states] = await Promise.all([deps.store.watches(uid), deps.store.states(uid)]);
      let health = '';
      if (deps.relay) {
        const relay = await relayStatus(deps.relay, deps.fetcher);
        health = `\nDelivery queue: ${relay.pending} waiting; ${relay.failed ?? 0} failed in the last seven days.`;
        if (relay.fault) health += `\nRelay needs attention (${escapeHtml(relay.fault.reason)}; ${relay.fault.count} recorded faults). Check the private Apps Script status.`;
      }
      if (deps.mode !== 'cloud') {
        const model = deps.ollama ?? localModel();
        health += `\nLocal AI: ${escapeHtml(model.model)} at ${escapeHtml(model.url)}`;
      }
      await send(chatId, statusReply(watches, states, now()) + health);
      return;
    }
    if (command?.name === 'check') {
      if (now() / 1000 - message.date > STALE_COMMAND_S) {
        await send(chatId, `${GREETING}\nYour PC was off when you sent that, so I didn't run it late. Send it again if you still want it.`);
        return;
      }
      const filter = command.filter.toLowerCase();
      const match = (watch: Watch) => !filter || watch.label.toLowerCase().includes(filter);
      if (deps.mode === 'cloud') {
        const [watches, states] = await Promise.all([deps.store.watches(uid), deps.store.states(uid)]);
        await send(chatId, cloudCheckReply(watches.filter(watch => watch.enabled && match(watch)), states, now(), command.filter));
        return;
      }
      if (checking) { await send(chatId, `${GREETING}\nI'm already checking. Results are on their way.`); return; }
      checking = true;
      try {
        await send(chatId, `${GREETING}\nChecking${filter ? ` “${escapeHtml(command.filter)}”` : ''} now…`);
        const totals = await enqueue(() => runOnce({ ...deps.base, owners: { [uid]: chatId }, store: deps.store, send: (c, t) => send(c, t), runner: 'local', manual: { uid, match }, translate: deps.base?.translate ?? ownerTranslator(deps.fetcher, deps.ollama ?? localModel()) }));
        const [watches, states] = await Promise.all([deps.store.watches(uid), deps.store.states(uid)]);
        const cloud = watches.filter(watch => watch.enabled && match(watch) && routeOf(states.get(watch.id), watch) === 'cloud').map(watch => watch.label);
        await send(chatId, checkReply(totals.outcomes, cloud, command.filter));
        log(`command check: ${totals.outcomes.length} watches, ${totals.changed} changed`);
      } finally { checking = false; }
      return;
    }
    const date = await today(uid);
    const editCommand = parseEdit(message.text ?? '');
    if (editCommand) {
      const plan = planEdit(editCommand, await deps.store.cards(uid), date);
      if (plan.error) { await send(chatId, `${GREETING}\n${escapeHtml(plan.error)}`); return; }
      await offer(uid, chatId, plan.changes, date, true, identity);
      log(`change proposed: ${editCommand.name}`);
      return;
    }
    const captured = parseCapture(message.text ?? '', date);
    if (captured && 'error' in captured) { await send(chatId, `${GREETING}\n${escapeHtml(captured.error)}`); return; }
    if (captured?.kind === 'parcel' && !parcelsOn) { await send(chatId, PARCELS_ARCHIVED_REPLY); return; }
    if (captured) {
      await offer(uid, chatId, [captured], date, false, identity);
      log(`capture proposed: ${captured.kind}`);
      return;
    }
    // Anything else is a question for the owner's local model.
    if (deps.mode === 'cloud') {
      await send(chatId, `${GREETING}\nI answer questions with the AI on your PC, which is off or asleep right now. Ask again when it's on. Commands like /done, /move and “remind me…” still work.`);
      return;
    }
    if (now() / 1000 - message.date > STALE_COMMAND_S) {
      await send(chatId, `${GREETING}\nYou asked that while your PC was off. Ask again if you still want an answer.`);
      return;
    }
    if (thinking) { await send(chatId, `${GREETING}\nI'm still working on your last question.`); return; }
    thinking = true;
    try {
      await call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
      const settings = await deps.store.settings(uid);
      const result = await answerQuestion(message.text ?? '', {
        uid, today: date, timeZone: settingsFrom(settings).timezone, store: deps.store, calendars: deps.calendars?.[uid] ?? [],
        ollama: deps.ollama ?? localModel(),
        fetcher: deps.fetcher, now,
      });
      // Persist the operation before replying so transport failures cannot make fresh proposals.
      if (result.proposals.length) await offer(uid, chatId, result.proposals, date, false, identity, result.answer);
      else await send(chatId, `${GREETING}\n${result.answer}`);
      log(`question ${result.status}: ${result.toolCalls} tool calls, ${result.proposals.length} proposals`);
    } catch {
      log('question failed; delivery remains retryable');
      throw new Error('Question handling failed.');
    } finally { thinking = false; }
  };
}

const UPDATES = encodeURIComponent('["message","callback_query"]');

export class PollHandlingError extends Error {
  nextOffset: number;
  constructor(nextOffset: number) { super('Message handling failed; offset retained.'); this.nextOffset = nextOffset; }
}

/** Long-poll Telegram for one batch of updates; returns the next offset. */
export async function pollOnce(deps: ListenDeps, offset: number, handle: (update: Update) => Promise<void>, timeoutS = 50) {
  const base = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  const url = `${base}/bot${deps.token}/getUpdates?timeout=${timeoutS}&offset=${offset}&allowed_updates=${UPDATES}`;
  const response = await (deps.fetcher ?? fetch)(url, { signal: AbortSignal.timeout((timeoutS + 15) * 1000) });
  if (!response.ok) throw new Error(`Telegram getUpdates returned HTTP ${response.status}`);
  const body = await response.json() as { result?: Update[] };
  let next = offset;
  for (const update of body.result ?? []) {
    try { await handle(update); next = Math.max(next, update.update_id + 1); }
    catch { throw new PollHandlingError(next); }
  }
  return next;
}

/**
 * The cloud runner's stand-in while the PC is off: handle whatever is waiting, then
 * acknowledge it so neither runner sees it again.
 */
/** How often the PC collects messages from the relay. */
export const RELAY_POLL_MS = 15_000;

/** Handle a single leased delivery. A crash or any failure leaves it recoverable. */
export async function relayRound(deps: ListenDeps, who: 'pc' | 'cloud', handle: (update: Update) => Promise<void>) {
  const delivery = await claimUpdate(deps.relay!, who, deps.fetcher);
  if (!delivery) return 0;
  let renewal: Promise<void> = Promise.resolve(), lost = false, renewing = false;
  const timer = setInterval(() => {
    if (renewing || lost) return;
    renewing = true;
    renewal = finishClaim(deps.relay!, who, delivery, 'renew', deps.fetcher)
      .catch(() => { lost = true; deps.log?.('delivery lease renewal failed'); })
      .finally(() => { renewing = false; });
  }, RELAY_RENEW_MS);
  try {
    if (delivery.failure) {
      const chats = delivery.chat ? Object.values(deps.owners).filter(c => c === delivery.chat) : [...new Set(Object.values(deps.owners))];
      const reasons: Record<string, string> = { expired: 'it waited more than 24 hours', attempts_exhausted: 'it failed repeatedly', malformed: 'the stored message could not be read', capacity: 'the queue was full', oversized: 'the message was too large' };
      for (const chat of chats) await sendTelegram(deps.token, chat,
        `${GREETING}\nA queued request could not be fully handled because ${reasons[delivery.failure]}. Check any existing confirmation before sending it again. /status shows delivery health.`, deps.fetcher);
    } else await handle(delivery.update!);
    clearInterval(timer);
    await renewal;
    if (lost) throw new Error('Delivery lease lost.');
    await finishClaim(deps.relay!, who, delivery, 'ack', deps.fetcher);
  } catch {
    deps.log?.('delivery incomplete; retained for retry');
  } finally { clearInterval(timer); await renewal; }
  return 1;
}

export async function drainOnce(deps: ListenDeps) {
  const handle = makeHandler({ ...deps, mode: 'cloud' }, makeQueue());
  if (deps.relay) {
    // Messages that arrive while this run works are collected too, a few rounds at most.
    for (let round = 0; round < 5 && await relayRound(deps, 'cloud', handle) > 0; round++);
    return;
  }
  const next = await pollOnce(deps, 0, handle, 0);
  if (next > 0) await pollOnce(deps, next, async () => {}, 0);
}

export async function listen(deps: ListenDeps) {
  const log = deps.log ?? (() => {});
  const enqueue = makeQueue();
  const handle = makeHandler({ ...deps, mode: 'local' }, enqueue);
  const scheduled = () => enqueue(() => runOnce({ ...deps.base, owners: deps.owners, store: deps.store, runner: 'local', translate: deps.base?.translate ?? ownerTranslator(deps.fetcher, deps.ollama ?? localModel()),
    send: (chatId, text) => sendTelegram(deps.token, chatId, text, deps.fetcher) })).catch(() => log('scheduled run failed'));
  // Show the commands in Telegram's "/" menu.
  await telegramCall(deps.token, 'setMyCommands', { commands: COMMANDS.filter(c => PARCELS_ENABLED || !['track', 'parcels'].includes(c.command)) }, deps.fetcher).catch(() => undefined);
  void scheduled();
  setInterval(() => void scheduled(), SCHEDULE_MS);
  log(deps.relay ? 'listening for commands (relay)' : 'listening for commands');
  let offset = 0, delay = 5_000;
  if (deps.relay) {
    // Telegram pushes to the relay; collect from it every few seconds.
    for (;;) {
      try { if (!await relayRound(deps, 'pc', handle)) await new Promise(resolve => setTimeout(resolve, RELAY_POLL_MS)); delay = 5_000; }
      catch { log('relay check failed; retrying'); await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 60_000); }
    }
  }
  for (;;) {
    try { offset = await pollOnce(deps, offset, handle); delay = 5_000; }
    catch (error) {
      if (error instanceof PollHandlingError) offset = error.nextOffset;
      log('poll failed; retrying');
      await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 300_000);
    }
  }
}
