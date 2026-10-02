// Ica answering open questions with the owner's local Ollama model. Read tools run
// immediately; anything that would change data only becomes a proposal the owner
// confirms with a button. Questions and data never leave the PC.
import { addDays, formatDue, LIMITS, type Proposal } from './capture.ts';
import { eventsBetween, fetchCalendars, formatEvent } from './calendar.ts';
import type { Bookmark } from './assistant.ts';
import { matchCards, type Change, type CardDoc, type EditStore } from './edit.ts';
import { escapeHtml } from './telegram.ts';
import { routeOf, type Store } from './run.ts';

export const LIMITS_AGENT = { rounds: 4, tools: 8, deadlineMs: 180_000, resultChars: 6000 } as const;
export const DEFAULT_OLLAMA = { url: 'http://localhost:11434', model: 'qwen3:14b' };

/** Only a model on this machine may receive the owner's data. */
export function localOllamaUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? url.origin : DEFAULT_OLLAMA.url;
  } catch { return DEFAULT_OLLAMA.url; }
}

export interface AgentContext {
  uid: string;
  today: string;
  timeZone: string;
  store: Store & EditStore & { unreadBookmarks(uid: string): Promise<Bookmark[]> };
  calendars: string[];
  ollama: { url: string; model: string };
  fetcher?: typeof fetch;
  now?: () => number;
}

const DATE = { type: 'string', description: 'YYYY-MM-DD' };
export const TOOLS = [
  { name: 'list_reminders', description: 'List reminders, soonest first, each with its due date. Either give from/to dates (inclusive) for a range, '
      + 'or when: overdue, today, tomorrow, this_week (next 7 days), upcoming (all not done), done (archived), all. '
      + 'For "before X", first find the date of X (it may itself be a reminder or a calendar event), then use to = the day before.',
    parameters: { type: 'object', properties: { when: { type: 'string', enum: ['overdue', 'today', 'tomorrow', 'this_week', 'upcoming', 'done', 'all'] }, from: DATE, to: DATE } } },
  { name: 'search_cards', description: 'Search My Space cards (notes, links, reminders) by words in the title or body.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['note', 'link', 'reminder'] } }, required: ['query'] } },
  { name: 'calendar_events', description: "Events from the owner's Google Calendar between two dates (inclusive).",
    parameters: { type: 'object', properties: { from: DATE, to: DATE }, required: ['from', 'to'] } },
  { name: 'reading_list', description: 'Unread links saved to the reading list.', parameters: { type: 'object', properties: {} } },
  { name: 'watch_status', description: 'Site watches with their last check and last change.', parameters: { type: 'object', properties: {} } },
  { name: 'propose_complete', description: 'Ask the owner to confirm marking a reminder done.',
    parameters: { type: 'object', properties: { card: { type: 'string', description: "The card's title or a few words of it (or its id)" } }, required: ['card'] } },
  { name: 'propose_move', description: "Ask the owner to confirm changing a reminder's due date.",
    parameters: { type: 'object', properties: { card: { type: 'string', description: "The card's title or a few words of it (or its id)" }, due_date: DATE }, required: ['card', 'due_date'] } },
  { name: 'propose_rename', description: 'Ask the owner to confirm renaming a card.',
    parameters: { type: 'object', properties: { card: { type: 'string', description: "The card's title or a few words of it (or its id)" }, title: { type: 'string' } }, required: ['card', 'title'] } },
  { name: 'propose_delete', description: 'Ask the owner to confirm deleting a card.',
    parameters: { type: 'object', properties: { card: { type: 'string', description: "The card's title or a few words of it (or its id)" } }, required: ['card'] } },
  { name: 'propose_reminder', description: 'Ask the owner to confirm adding a new reminder.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, due_date: DATE }, required: ['title'] } },
  { name: 'propose_note', description: 'Ask the owner to confirm adding a new note.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] } },
].map(fn => ({ type: 'function', function: fn }));

const validDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));
const brief = (c: CardDoc) => ({ id: c.id, kind: c.kind, title: c.title, ...(c.kind === 'reminder' ? { due: c.dueDate || 'none', done: c.done } : {}), ...(c.body ? { body: c.body.slice(0, 300) } : {}), ...(c.url ? { url: c.url } : {}) });

export interface AgentResult { answer: string; proposals: (Proposal | Change)[]; toolCalls: number; /** Tool names and arguments, for tests (never logged). */ trace: string[] }

export function systemPrompt(today: string, timeZone: string, upcoming: CardDoc[] = []) {
  const weekday = new Date(today + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return [
    "You are Ica, the owner's personal assistant inside Voracity, replying on Telegram.",
    `Today is ${weekday} ${today} (${timeZone}). Use YYYY-MM-DD dates in tool calls.`,
    'Look facts up with the tools. Never invent reminders, events, cards or links; if the tools return nothing, say so.',
    'To change or add anything, call the matching propose_* tool. The owner confirms with a button; do not claim it is already done.',
    'Answer briefly and plainly (a few lines or a short list). No headings. Use **bold** sparingly.',
    'Never guess a date. The open reminders are listed below; look anything else up with the tools.',
    'For "what\'s on", "am I free" or plans for a day, check both calendar_events and list_reminders.',
    '"Next <weekday>" and "this <weekday>" mean the first such day after today, as listed below.',
    '',
    'Coming days:',
    ...Array.from({ length: 14 }, (_, i) => {
      const date = addDays(today, i + 1);
      return `${new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} ${date}`;
    }),
    '',
    'Open reminders (due date, title):',
    ...(upcoming.length ? upcoming.map(c => `${c.dueDate || 'no date'}  ${c.title}`) : ['(none)']),
  ].join('\n');
}

const CLAIMS = /\b(has been|have been|is now|are now|marked|moved|deleted|removed|renamed|added|created|saved|updated|rescheduled)\b/i;

/** The model must not say a change happened before the owner confirms it. */
export function confirmationAnswer(answer: string, proposals: number) {
  if (!proposals) return answer;
  const ask = proposals === 1 ? 'Tap below to confirm.' : 'Tap below to confirm each one.';
  return !answer || CLAIMS.test(answer) ? ask : `${answer}\n\n${ask}`;
}

/** Telegram HTML: escape everything, then allow **bold**. Drops any leaked <think> block. */
export function toTelegramHtml(text: string) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const html = escapeHtml(clean).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^#{1,6}\s+/gm, '');
  return html.length > 3500 ? html.slice(0, 3499) + '…' : html;
}

export async function answerQuestion(question: string, ctx: AgentContext): Promise<AgentResult> {
  const now = ctx.now ?? Date.now;
  const fetcher = ctx.fetcher ?? fetch;
  const deadline = now() + LIMITS_AGENT.deadlineMs;
  const proposals: (Proposal | Change)[] = [];
  let cardsCache: CardDoc[] | null = null, calendarCache: string[] | null = null;
  const cards = async () => (cardsCache ??= await ctx.store.cards(ctx.uid));
  /** Resolve a card the model named by id or by title words, as /done does; never guess between several. */
  async function resolve(ref: unknown, kind?: CardDoc['kind'], openOnly = false): Promise<CardDoc | { error: string; options?: { id: string; title: string; due?: string }[] }> {
    const pool = (await cards()).filter(c => (!kind || c.kind === kind) && (!openOnly || !c.done));
    const text = String(ref ?? '').trim();
    const byId = pool.find(c => c.id === text);
    if (byId) return byId;
    const found = matchCards(pool, text, 5);
    if (found.length === 1) return found[0];
    if (!found.length) return { error: `No ${kind ?? 'card'} matches “${text}”. Use list_reminders or search_cards to find it.` };
    return { error: 'Several match. Ask the owner which one they mean, or call again with one of these ids.', options: found.map(c => ({ id: c.id, title: c.title, ...(c.dueDate ? { due: c.dueDate } : {}) })) };
  }
  const isCard = (value: unknown): value is CardDoc => !!value && typeof value === 'object' && 'revision' in value;

  async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'list_reminders': {
        const all = (await cards()).filter(c => c.kind === 'reminder');
        const t = ctx.today, week = addDays(t, 7);
        const pick: Record<string, (c: CardDoc) => boolean> = {
          overdue: c => !c.done && !!c.dueDate && c.dueDate < t, today: c => !c.done && c.dueDate === t, tomorrow: c => !c.done && c.dueDate === addDays(t, 1),
          this_week: c => !c.done && !!c.dueDate && c.dueDate >= t && c.dueDate <= week, upcoming: c => !c.done && (!c.dueDate || c.dueDate >= t),
          done: c => c.done, all: () => true,
        };
        const ranged = validDate(args.from) || validDate(args.to);
        const inRange = (c: CardDoc) => !c.done && !!c.dueDate && (!validDate(args.from) || c.dueDate >= args.from) && (!validDate(args.to) || c.dueDate <= args.to);
        const list = all.filter(ranged ? inRange : pick[String(args.when)] ?? pick.upcoming).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
        return list.slice(0, 40).map(brief);
      }
      case 'search_cards': {
        const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = (await cards()).filter(c => (!args.kind || c.kind === args.kind) && terms.some(w => `${c.title} ${c.body} ${c.url}`.toLowerCase().includes(w)));
        return hits.slice(0, 20).map(brief);
      }
      case 'calendar_events': {
        if (!ctx.calendars.length) return { error: 'No calendar is connected. The owner can add their Google Calendar secret iCal address to the watcher.' };
        if (!validDate(args.from) || !validDate(args.to)) return { error: 'Use YYYY-MM-DD dates.' };
        calendarCache ??= (await fetchCalendars(ctx.calendars, fetcher)).texts;
        const to = args.to < args.from ? args.from : args.to;
        return eventsBetween(calendarCache, args.from, String(to) > addDays(args.from, 62) ? addDays(args.from, 62) : String(to), ctx.timeZone)
          .slice(0, 50).map(e => ({ date: e.date, event: formatEvent(e) }));
      }
      case 'reading_list': return (await ctx.store.unreadBookmarks(ctx.uid)).slice(0, 20).map(b => ({ title: b.title, url: b.url }));
      case 'watch_status': {
        const [watches, states] = await Promise.all([ctx.store.watches(ctx.uid), ctx.store.states(ctx.uid)]);
        return watches.map(w => { const s = states.get(w.id); return { name: w.label, from: routeOf(s, w) === 'local' ? 'PC' : 'GitHub', status: s?.status ?? 'not checked', lastChange: s?.summary ?? null }; });
      }
      case 'propose_complete': {
        const c = await resolve(args.card ?? args.id, 'reminder', true);
        if (!isCard(c)) return c;
        proposals.push({ kind: 'complete', cardId: c.id, title: c.title, revision: c.revision });
        return { proposed: true };
      }
      case 'propose_move': {
        const c = await resolve(args.card ?? args.id, 'reminder');
        if (!isCard(c)) return c;
        if (!validDate(args.due_date)) return { error: 'due_date must be YYYY-MM-DD.' };
        proposals.push({ kind: 'update', cardId: c.id, title: c.title, revision: c.revision, changes: { dueDate: args.due_date } });
        return { proposed: true };
      }
      case 'propose_rename': {
        const c = await resolve(args.card ?? args.id), title = String(args.title ?? '').trim();
        if (!isCard(c)) return c;
        if (!title || title.length > LIMITS.title) return { error: `title must be 1-${LIMITS.title} characters.` };
        proposals.push({ kind: 'update', cardId: c.id, title: c.title, revision: c.revision, changes: { title } });
        return { proposed: true };
      }
      case 'propose_delete': {
        const c = await resolve(args.card ?? args.id);
        if (!isCard(c)) return c;
        proposals.push({ kind: 'delete', cardId: c.id, title: c.title, revision: c.revision, cardKind: c.kind });
        return { proposed: true };
      }
      case 'propose_reminder': {
        const title = String(args.title ?? '').trim();
        if (!title || title.length > LIMITS.title) return { error: `title must be 1-${LIMITS.title} characters.` };
        if (args.due_date !== undefined && args.due_date !== '' && !validDate(args.due_date)) return { error: 'due_date must be YYYY-MM-DD.' };
        proposals.push({ kind: 'reminder', title, body: '', dueDate: validDate(args.due_date) ? args.due_date : '' });
        return { proposed: true };
      }
      case 'propose_note': {
        const title = String(args.title ?? '').trim();
        if (!title || title.length > LIMITS.title) return { error: `title must be 1-${LIMITS.title} characters.` };
        proposals.push({ kind: 'note', title, body: String(args.body ?? '').slice(0, LIMITS.body) });
        return { proposed: true };
      }
      default: return { error: `Unknown tool ${name}.` };
    }
  }

  // The open reminders give the model their dates up front (it otherwise guesses them).
  const open = (await cards()).filter(c => c.kind === 'reminder' && !c.done)
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 30);
  const messages: Record<string, unknown>[] = [{ role: 'system', content: systemPrompt(ctx.today, ctx.timeZone, open) }, { role: 'user', content: question.slice(0, 4000) }];
  let toolCalls = 0;
  const trace: string[] = [];
  for (let round = 0; round < LIMITS_AGENT.rounds; round++) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const response = await fetcher(`${ctx.ollama.url}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(Math.min(remaining, 120_000)),
      body: JSON.stringify({ model: ctx.ollama.model, messages, tools: TOOLS, stream: false, think: false, options: { temperature: 0.2, num_ctx: 8192 } }),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const reply = (await response.json() as { message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } }).message ?? {};
    const calls = (reply.tool_calls ?? []).filter(call => call.function?.name);
    if (!calls.length || toolCalls >= LIMITS_AGENT.tools) {
      const answer = confirmationAnswer(toTelegramHtml(reply.content ?? ''), proposals.length) || "I couldn't work that out.";
      return { answer, proposals, toolCalls, trace };
    }
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: calls });
    for (const call of calls) {
      if (toolCalls >= LIMITS_AGENT.tools) break;
      toolCalls++;
      const raw = call.function!.arguments;
      const args = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch { return {}; } })() : raw ?? {}) as Record<string, unknown>;
      trace.push(`${call.function!.name}(${JSON.stringify(args)})`);
      let result: unknown;
      try { result = await run(call.function!.name!, args); } catch { result = { error: 'That lookup failed.' }; }
      const text = JSON.stringify(result);
      messages.push({ role: 'tool', tool_name: call.function!.name, content: text.length > LIMITS_AGENT.resultChars ? text.slice(0, LIMITS_AGENT.resultChars) + '…(truncated)' : text });
    }
  }
  return { answer: confirmationAnswer(proposals.length ? '' : 'That took too many steps. Try asking more specifically.', proposals.length), proposals, toolCalls, trace };
}

export { formatDue };
