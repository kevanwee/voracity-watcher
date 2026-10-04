// Ica's Telegram side. On the owner's PC this is a long-running listener that also runs
// the 5-minute schedule, all through one queue so a requested check never overlaps a
// scheduled one. When the PC is off, the cloud runner reads pending messages instead
// (mode 'cloud'), so quick capture still works from a phone.
import { DEFAULT_OLLAMA, answerQuestion, localOllamaUrl } from './agent.ts';
import { localClock, settingsFrom, type AssistantSettings, type Bookmark } from './assistant.ts';
import { LIMITS, formatDue, parseCapture, type Proposal } from './capture.ts';
import { applyChange, changeButtonLabel, changeQuestion, changeResultText, isChange, parseEdit, planEdit, type Change, type EditStore } from './edit.ts';
import { GREETING, escapeHtml, sendTelegram, telegramCall } from './telegram.ts';
import { parcelFor, parcelsReply, type Parcel, type ParcelState } from './parcels.ts';
import { ownerTranslator } from './translate.ts';
import { takeUpdates, type Relay } from './relay.ts';
import { routeOf, runOnce, type Deps, type Outcome, type Store, type Watch, type WatchState } from './run.ts';

export const SCHEDULE_MS = 5 * 60_000;
/** Check commands sent while the PC was off are not run late; Ica says so instead. */
export const STALE_COMMAND_S = 10 * 60;
/** Unconfirmed proposals are forgotten after a day (Telegram also keeps updates for 24 h). */
export const PROPOSAL_TTL_MS = 86_400_000;

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

/** Card and bookmark documents exactly as Voracity creates them (model.ts, bookmarks.ts, firestore.rules). */
export function cardFor(p: Extract<Proposal, { kind: 'reminder' | 'note' }>, now: number) {
  return { id: crypto.randomUUID(), kind: p.kind, title: p.title.slice(0, LIMITS.title), body: p.body.slice(0, LIMITS.body), url: '',
    dueDate: p.kind === 'reminder' ? p.dueDate : '', done: false, pinned: false, tone: 'cream', createdAt: now, updatedAt: now, revision: 0 };
}
export function bookmarkFor(p: Extract<Proposal, { kind: 'bookmark' }>, now: number) {
  return { id: crypto.randomUUID(), url: p.url, title: p.title.slice(0, LIMITS.bookmarkTitle), snippet: '', tags: [] as string[], status: 'unread', createdAt: now, updatedAt: now, revision: 0 };
}
export type NewCard = ReturnType<typeof cardFor>;
export type NewBookmark = ReturnType<typeof bookmarkFor>;

export type Pending = (Proposal | Change) & { createdAt: number };
export interface CaptureStore extends EditStore {
  settings(uid: string): Promise<Partial<AssistantSettings> | null>;
  /** The owner's Second Brain settings (users/{uid}/settings/brain): local model and address. */
  brainSettings(uid: string): Promise<{ ollamaUrl?: string; ollamaModel?: string } | null>;
  unreadBookmarks(uid: string): Promise<Bookmark[]>;
  /** Runner-only: users/{uid}/assistant/inbox. */
  inbox(uid: string): Promise<Record<string, Pending>>;
  saveInbox(uid: string, pending: Record<string, Pending>): Promise<void>;
  createCard(uid: string, card: NewCard): Promise<void>;
  createBookmark(uid: string, bookmark: NewBookmark): Promise<void>;
  parcels(uid: string): Promise<Parcel[]>;
  parcelStates(uid: string): Promise<Map<string, ParcelState>>;
  createParcel(uid: string, parcel: Parcel): Promise<void>;
}

export interface ListenDeps {
  token: string;
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

// Short enough that a button can carry three sibling IDs within Telegram's 64-byte callback limit.
const proposalId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

export function makeHandler(deps: ListenDeps, enqueue: ReturnType<typeof makeQueue>) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const send = (chatId: string, text: string, buttons?: { text: string; data: string }[][]) => sendTelegram(deps.token, chatId, text, deps.fetcher, buttons);
  const call = (method: string, payload: Record<string, unknown>) => telegramCall(deps.token, method, payload, deps.fetcher);
  const ownerByChat = new Map(Object.entries(deps.owners).map(([uid, chat]) => [chat, uid]));
  const today = async (uid: string) => localClock(now(), settingsFrom(await deps.store.settings(uid)).timezone).date;
  const livePending = async (uid: string) =>
    Object.fromEntries(Object.entries(await deps.store.inbox(uid)).filter(([, p]) => now() - p.createdAt < PROPOSAL_TTL_MS));
  let checking = false;

  async function confirm(update: NonNullable<Update['callback_query']>) {
    const chatId = String(update.message?.chat.id ?? ''), uid = ownerByChat.get(chatId);
    if (!uid || !update.message) return;
    const [action, id, revision] = (update.data ?? '').split(':');
    const edit = (text: string) => call('editMessageText', { chat_id: chatId, message_id: update.message!.message_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    if (action === 'done') {
      // One-tap "✓" from the briefing or a reminder alert: an explicit action, still revision-checked.
      const card = (await deps.store.cards(uid)).find(c => c.id === id);
      const result = !card ? 'missing' : card.done ? 'ok' : await deps.store.updateCard(uid, id, Number(revision), { done: true }, now());
      const title = card?.title ?? 'That reminder';
      const toast = result === 'ok' ? `✓ ${title} is done` : result === 'missing' ? `${title} no longer exists` : `${title} changed elsewhere; send /done to try again`;
      await call('answerCallbackQuery', { callback_query_id: update.id, text: toast.slice(0, 190) }).catch(() => undefined);
      log(`reminder done from button: ${result}`);
      return;
    }
    await call('answerCallbackQuery', { callback_query_id: update.id }).catch(() => undefined);
    const pending = await livePending(uid);
    if (action === 'cancel') {
      for (const one of id.split(',')) delete pending[one];
      await deps.store.saveInbox(uid, pending);
      await edit(`${GREETING}\nOK, I left it as it is.`);
      return;
    }
    const proposal = pending[id];
    if (!proposal) { await edit(`${GREETING}\nThat one expired or was already handled. Send it again if you still want it.`); return; }
    // Siblings offered in the same message (several matches) are dropped once one is chosen.
    for (const sibling of (update.data ?? '').split(':')[2]?.split(',') ?? []) delete pending[sibling];
    delete pending[id];
    const { createdAt: _created, ...p } = proposal;
    const date = await today(uid);
    if (isChange(p)) {
      const result = await applyChange(deps.store, uid, p, now());
      await deps.store.saveInbox(uid, pending);
      await edit(changeResultText(p, result, date));
      log(`change ${p.kind}: ${result}`);
      return;
    }
    if (p.kind === 'parcel') {
      // Refuse a number that is already being tracked, as Voracity does.
      if ((await deps.store.parcels(uid)).some(parcel => parcel.number === p.number && !parcel.archived)) {
        await deps.store.saveInbox(uid, pending);
        await edit(`${GREETING}\nYou're already tracking <code>${escapeHtml(p.number)}</code>. /parcels shows its status.`);
        return;
      }
      await deps.store.createParcel(uid, parcelFor(p, now()));
    }
    else if (p.kind === 'bookmark') await deps.store.createBookmark(uid, bookmarkFor(p, now()));
    else await deps.store.createCard(uid, cardFor(p, now()));
    await deps.store.saveInbox(uid, pending);
    await edit(`${GREETING}\n${savedText(p, date)}`);
    log(`capture saved: ${p.kind}`);
  }

  /** Offer proposals: several edit candidates share one message; anything else gets its own. */
  async function offer(uid: string, chatId: string, items: (Proposal | Change)[], date: string, together: boolean) {
    const pending = await livePending(uid);
    const ids = items.map(() => proposalId());
    items.forEach((item, i) => { pending[ids[i]] = { ...item, createdAt: now() }; });
    await deps.store.saveInbox(uid, pending);
    if (together && items.length > 1) {
      const others = ids.join(',');
      await send(chatId, changeQuestion(items as Change[], date), [
        ...items.map((item, i) => [{ text: changeButtonLabel(item as Change), data: `save:${ids[i]}:${others}` }]),
        [{ text: 'Cancel', data: `cancel:${others}` }],
      ]);
      return;
    }
    for (const [i, item] of items.entries()) {
      const text = isChange(item) ? changeQuestion([item], date) : proposalText(item, date);
      const yes = isChange(item) ? (item.kind === 'delete' ? 'Delete' : item.kind === 'complete' ? 'Mark done' : 'Update') : 'Save';
      await send(chatId, text, [[{ text: yes, data: `save:${ids[i]}` }, { text: 'Cancel', data: `cancel:${ids[i]}` }]]);
    }
  }
  let thinking = false;

  return async function handle(update: Update) {
    if (update.callback_query) { await confirm(update.callback_query); return; }
    const message = update.message;
    if (!message) return;
    const chatId = String(message.chat.id), uid = ownerByChat.get(chatId);
    if (!uid) return; // Only owners in WATCHER_OWNERS can talk to Ica; everyone else is ignored.
    const command = parseCommand(message.text);
    if (command?.name === 'help') { await send(chatId, helpReply()); return; }
    if (command?.name === 'parcels') {
      const [parcels, states] = await Promise.all([deps.store.parcels(uid), deps.store.parcelStates(uid)]);
      await send(chatId, parcelsReply(parcels, states));
      return;
    }
    if (command?.name === 'status') {
      const [watches, states] = await Promise.all([deps.store.watches(uid), deps.store.states(uid)]);
      await send(chatId, statusReply(watches, states, now()));
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
        const totals = await enqueue(() => runOnce({ ...deps.base, owners: { [uid]: chatId }, store: deps.store, send: (c, t) => send(c, t), runner: 'local', manual: { uid, match }, translate: deps.base?.translate ?? ownerTranslator(deps.store, deps.fetcher) }));
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
      await offer(uid, chatId, plan.changes, date, true);
      log(`change proposed: ${editCommand.name}`);
      return;
    }
    const captured = parseCapture(message.text ?? '', date);
    if (captured && 'error' in captured) { await send(chatId, `${GREETING}\n${escapeHtml(captured.error)}`); return; }
    if (captured) {
      await offer(uid, chatId, [captured], date, false);
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
      const [settings, brain] = await Promise.all([deps.store.settings(uid), deps.store.brainSettings(uid)]);
      const result = await answerQuestion(message.text ?? '', {
        uid, today: date, timeZone: settingsFrom(settings).timezone, store: deps.store, calendars: deps.calendars?.[uid] ?? [],
        ollama: { url: localOllamaUrl(brain?.ollamaUrl ?? DEFAULT_OLLAMA.url), model: brain?.ollamaModel || DEFAULT_OLLAMA.model },
        fetcher: deps.fetcher, now,
      });
      await send(chatId, `${GREETING}\n${result.answer}`);
      if (result.proposals.length) await offer(uid, chatId, result.proposals, date, false);
      log(`question answered: ${result.toolCalls} tool calls, ${result.proposals.length} proposals`);
    } catch {
      await send(chatId, `${GREETING}\nI couldn't reach the AI on your PC. Check that Ollama is running, then ask again.`);
      log('question failed');
    } finally { thinking = false; }
  };
}

const UPDATES = encodeURIComponent('["message","callback_query"]');

/** Long-poll Telegram for one batch of updates; returns the next offset. */
export async function pollOnce(deps: ListenDeps, offset: number, handle: (update: Update) => Promise<void>, timeoutS = 50) {
  const base = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  const url = `${base}/bot${deps.token}/getUpdates?timeout=${timeoutS}&offset=${offset}&allowed_updates=${UPDATES}`;
  const response = await (deps.fetcher ?? fetch)(url, { signal: AbortSignal.timeout((timeoutS + 15) * 1000) });
  if (!response.ok) throw new Error(`Telegram getUpdates returned HTTP ${response.status}`);
  const body = await response.json() as { result?: Update[] };
  let next = offset;
  for (const update of body.result ?? []) {
    next = Math.max(next, update.update_id + 1);
    try { await handle(update); } catch { deps.log?.('message handling failed'); }
  }
  return next;
}

/**
 * The cloud runner's stand-in while the PC is off: handle whatever is waiting, then
 * acknowledge it so neither runner sees it again.
 */
/** How often the PC collects messages from the relay. */
export const RELAY_POLL_MS = 3_000;

/** Collect and handle one batch from the relay; returns how many messages there were. */
export async function relayRound(deps: ListenDeps, who: 'pc' | 'cloud', handle: (update: Update) => Promise<void>) {
  const updates = await takeUpdates(deps.relay!, who, deps.fetcher);
  for (const update of updates) {
    try { await handle(update); } catch { deps.log?.('message handling failed'); }
  }
  return updates.length;
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
  const scheduled = () => enqueue(() => runOnce({ ...deps.base, owners: deps.owners, store: deps.store, runner: 'local', translate: deps.base?.translate ?? ownerTranslator(deps.store, deps.fetcher),
    send: (chatId, text) => sendTelegram(deps.token, chatId, text, deps.fetcher) })).catch(() => log('scheduled run failed'));
  // Show the commands in Telegram's "/" menu.
  await telegramCall(deps.token, 'setMyCommands', { commands: COMMANDS }, deps.fetcher).catch(() => undefined);
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
    catch { log('poll failed; retrying'); await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 300_000); }
  }
}
