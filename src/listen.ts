// The local runner as one long-running process: it runs the 5-minute schedule and
// answers the owner's Telegram commands, all through a single queue so a requested
// check can never overlap a scheduled one (no duplicate alerts).
import { GREETING, escapeHtml, sendTelegram } from './telegram.ts';
import { routeOf, runOnce, type Deps, type Outcome, type Store, type Watch, type WatchState } from './run.ts';

export const SCHEDULE_MS = 5 * 60_000;
/** Commands sent while the PC was off are not run late; Ica says so instead. */
export const STALE_COMMAND_S = 10 * 60;

export const COMMANDS = [
  { command: 'check', description: 'Check your PC watches now (add a name to check one)' },
  { command: 'status', description: 'Show each watch and its last check' },
  { command: 'help', description: 'What Ica can do' },
];

export interface Update { update_id: number; message?: { date: number; text?: string; chat: { id: number } } }

export type Command = { name: 'check'; filter: string } | { name: 'status' } | { name: 'help' } | null;

/** Accepts "/check", "/check@SomeBot ex13", "check ex13", "status", "/help", "/start". */
export function parseCommand(text: string | undefined): Command {
  const match = text?.trim().match(/^\/?([a-z]+)(?:@\w+)?(?:\s+(.*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase(), rest = (match[2] ?? '').trim();
  if (name === 'check') return { name: 'check', filter: rest };
  if (name === 'status') return { name: 'status' };
  if (name === 'help' || name === 'start') return { name: 'help' };
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
  return [GREETING, 'I watch your sites and tell you when they change.',
    '/check: check your PC watches now',
    '/check <name>: check the watches whose name contains it',
    '/status: each watch, where it is checked from, and its last check'].join('\n');
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

export function statusReply(watches: Watch[], states: Map<string, WatchState>, now: number) {
  if (!watches.length) return `${GREETING}\nNo watches yet. Add one in Voracity's Site watcher.`;
  return [GREETING, ...watches.map(watch => {
    const state = states.get(watch.id);
    const where = routeOf(state, watch) === 'local' ? 'your PC' : 'GitHub';
    const last = !state ? 'not checked yet'
      : state.status === 'error' ? `check failed ${ago(state.checkedAt, now)}: ${state.error ?? 'unknown error'}`
      : `checked ${ago(state.checkedAt, now)}, ${state.itemCount ?? 0} items${state.changedAt ? `; changed ${ago(state.changedAt, now)}${state.summary ? ` (${state.summary})` : ''}` : ''}`;
    return `• <b>${escapeHtml(watch.label)}</b>${watch.enabled ? '' : ' (paused)'}, from ${where}: ${escapeHtml(last)}`;
  })].join('\n');
}

export interface ListenDeps {
  token: string;
  owners: Record<string, string>;
  store: Store;
  base: Omit<Deps, 'owners' | 'store' | 'send' | 'runner' | 'manual' | 'test'>;
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
  const send = (chatId: string, text: string) => sendTelegram(deps.token, chatId, text, deps.fetcher);
  const ownerByChat = new Map(Object.entries(deps.owners).map(([uid, chat]) => [chat, uid]));
  let checking = false;
  return async function handle(update: Update) {
    const message = update.message;
    if (!message) return;
    const chatId = String(message.chat.id), uid = ownerByChat.get(chatId);
    if (!uid) return; // Only owners in WATCHER_OWNERS can command Ica; everyone else is ignored.
    const command = parseCommand(message.text);
    if (!command) { await send(chatId, `${GREETING}\nI didn't catch that. Try /check or /status.`); return; }
    if (now() / 1000 - message.date > STALE_COMMAND_S) {
      await send(chatId, `${GREETING}\nYour PC was off when you sent that, so I didn't run it late. Send it again if you still want it.`);
      return;
    }
    if (command.name === 'help') { await send(chatId, helpReply()); return; }
    if (command.name === 'status') {
      const [watches, states] = await Promise.all([deps.store.watches(uid), deps.store.states(uid)]);
      await send(chatId, statusReply(watches, states, now()));
      return;
    }
    if (checking) { await send(chatId, `${GREETING}\nI'm already checking. Results are on their way.`); return; }
    checking = true;
    try {
      const filter = command.filter.toLowerCase();
      const match = (watch: Watch) => !filter || watch.label.toLowerCase().includes(filter);
      await send(chatId, `${GREETING}\nChecking${filter ? ` “${escapeHtml(command.filter)}”` : ''} now…`);
      const totals = await enqueue(() => runOnce({ ...deps.base, owners: { [uid]: chatId }, store: deps.store, send, runner: 'local', manual: { uid, match } }));
      const [watches, states] = await Promise.all([deps.store.watches(uid), deps.store.states(uid)]);
      const cloud = watches.filter(watch => watch.enabled && match(watch) && routeOf(states.get(watch.id), watch) === 'cloud').map(watch => watch.label);
      await send(chatId, checkReply(totals.outcomes, cloud, command.filter));
      log(`command check: ${totals.outcomes.length} watches, ${totals.changed} changed`);
    } finally { checking = false; }
  };
}

/** Long-poll Telegram for one batch of updates; returns the next offset. */
export async function pollOnce(deps: ListenDeps, offset: number, handle: (update: Update) => Promise<void>, timeoutS = 50) {
  const base = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  const url = `${base}/bot${deps.token}/getUpdates?timeout=${timeoutS}&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
  const response = await (deps.fetcher ?? fetch)(url, { signal: AbortSignal.timeout((timeoutS + 15) * 1000) });
  if (!response.ok) throw new Error(`Telegram getUpdates returned HTTP ${response.status}`);
  const body = await response.json() as { result?: Update[] };
  let next = offset;
  for (const update of body.result ?? []) {
    next = Math.max(next, update.update_id + 1);
    try { await handle(update); } catch { deps.log?.('command failed'); }
  }
  return next;
}

export async function listen(deps: ListenDeps) {
  const log = deps.log ?? (() => {});
  const enqueue = makeQueue();
  const handle = makeHandler(deps, enqueue);
  const scheduled = () => enqueue(() => runOnce({ ...deps.base, owners: deps.owners, store: deps.store, runner: 'local',
    send: (chatId, text) => sendTelegram(deps.token, chatId, text, deps.fetcher) })).catch(() => log('scheduled run failed'));
  const base = process.env.TELEGRAM_API ?? 'https://api.telegram.org';
  // Show the commands in Telegram's "/" menu.
  await (deps.fetcher ?? fetch)(`${base}/bot${deps.token}/setMyCommands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: COMMANDS }) }).catch(() => undefined);
  void scheduled();
  setInterval(() => void scheduled(), SCHEDULE_MS);
  log('listening for commands');
  let offset = 0, delay = 5_000;
  for (;;) {
    try { offset = await pollOnce(deps, offset, handle); delay = 5_000; }
    catch { log('poll failed; retrying'); await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 300_000); }
  }
}
