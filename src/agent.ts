// Ica answering open questions with the owner's local Ollama model. Read tools run
// immediately; anything that would change data only becomes a proposal the owner
// confirms with a button. Inference stays on the PC; Telegram/Firestore remain external services.
import { addDays, formatDue, LIMITS, safeUrl, type Proposal } from './capture.ts';
import { eventsBetween, fetchCalendars, formatEvent } from './calendar.ts';
import type { Bookmark } from './assistant.ts';
import { matchCards, type Change, type CardDoc, type EditStore } from './edit.ts';
import { escapeHtml } from './telegram.ts';
import { routeOf, type Store } from './run.ts';

import { realDate, validateAction } from './confirmations.ts';
import { AgentStop, LIMITS_AGENT, agentBudget, boundedText, plainObject, toolResult, type StopReason } from './agent-policy.ts';
import { modelReply, parseToolArguments } from './agent-contracts.ts';
import { validateLocalModel } from './local-model.ts';
export { LIMITS_AGENT } from './agent-policy.ts';
export { DEFAULT_OLLAMA, localOllamaUrl } from './local-model.ts';

export interface AgentContext {
  uid: string;
  today: string;
  timeZone: string;
  store: Store & EditStore & { unreadBookmarks(uid: string): Promise<Bookmark[]> };
  calendars: string[];
  ollama: { url: string; model: string };
  fetcher?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
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
].map(fn => ({ type: 'function', function: { ...fn, parameters: { ...fn.parameters, additionalProperties: false } } }));

const validDate = (v: unknown): v is string => realDate(v);
const brief = (c: CardDoc) => ({ id: c.id, kind: c.kind, title: c.title, ...(c.kind === 'reminder' ? { due: c.dueDate || 'none', done: c.done } : {}), ...(c.body ? { body: c.body.slice(0, 300) } : {}), ...(c.url ? { url: c.url } : {}) });

export interface AgentResult {
  answer: string; proposals: (Proposal | Change)[]; toolCalls: number;
  status: 'complete' | StopReason;
  usage: { inputBytes: number; responseBytes: number; rounds: number };
  /** Tool names only; arguments and owner content are never diagnostic output. */
  trace: string[];
}

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
  if (html.length <= 3500) return html;
  let clipped = '';
  for (const char of clean.replace(/\*\*/g, '')) {
    const escaped = escapeHtml(char);
    if (clipped.length + escaped.length > 3496) break;
    clipped += escaped;
  }
  return clipped + '...';
}

export async function answerQuestion(question: string, ctx: AgentContext): Promise<AgentResult> {
  const now = ctx.now ?? Date.now;
  const fetcher = ctx.fetcher ?? fetch;
  const budget = agentBudget(now, ctx.signal);
  const usage = { inputBytes: 0, responseBytes: 0, rounds: 0 };
  let toolCalls = 0;
  const trace: string[] = [];
  const proposals: (Proposal | Change)[] = [];
  let cardsCache: CardDoc[] | null = null, calendarCache: string[] | null = null;
  const cards = async () => {
    if (cardsCache) return cardsCache;
    let values: CardDoc[];
    try { values = await budget.wait(() => ctx.store.cards(ctx.uid)); }
    catch (error) { if (error instanceof AgentStop) throw error; throw new AgentStop('lookup_failed'); }
    if (!Array.isArray(values) || values.length > LIMITS_AGENT.storedCards) throw new AgentStop('invalid_result');
    const eligible = values.filter(c => (c as CardDoc & { ai?: boolean })?.ai !== false);
    if (eligible.some(c => !plainObject(c) || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id)
      || !['note', 'link', 'reminder'].includes(c.kind) || typeof c.title !== 'string' || c.title.length > LIMITS.title
      || typeof c.body !== 'string' || c.body.length > LIMITS.body || typeof c.url !== 'string' || c.url.length > LIMITS.url
      || typeof c.done !== 'boolean' || !Number.isSafeInteger(c.revision) || c.revision < 0
      || (c.dueDate !== '' && !realDate(c.dueDate)))) throw new AgentStop('invalid_result');
    return cardsCache = eligible;
  };
  const propose = (value: Proposal | Change) => { budget.check(); proposals.push(validateAction(value)); };
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
        return list.map(brief);
      }
      case 'search_cards': {
        const terms = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = (await cards()).filter(c => (!args.kind || c.kind === args.kind) && terms.some(w => `${c.title} ${c.body} ${c.url}`.toLowerCase().includes(w)));
        return hits.map(brief);
      }
      case 'calendar_events': {
        if (!ctx.calendars.length) return { error: 'No calendar is connected. The owner can add their Google Calendar secret iCal address to the watcher.' };
        if (!validDate(args.from) || !validDate(args.to)) return { error: 'Use YYYY-MM-DD dates.' };
        if (!calendarCache) {
          const fetched = await fetchCalendars(ctx.calendars, fetcher, budget.signal);
          if (fetched.failed) return { error: 'Some calendar sources could not be read; coverage is incomplete.' };
          calendarCache = fetched.texts;
        }
        const to = args.to < args.from ? args.from : args.to;
        return eventsBetween(calendarCache, args.from, String(to) > addDays(args.from, 62) ? addDays(args.from, 62) : String(to), ctx.timeZone)
          .map(e => ({ date: e.date, event: formatEvent(e) }));
      }
      case 'reading_list': {
        const bookmarks = await ctx.store.unreadBookmarks(ctx.uid);
        if (!Array.isArray(bookmarks) || bookmarks.length > 2000 || bookmarks.some(b => !plainObject(b) || typeof b.title !== 'string'
          || b.title.length > 200 || typeof b.url !== 'string' || b.url.length > LIMITS.url || !safeUrl(b.url))) throw new AgentStop('invalid_result');
        return bookmarks.filter(b => (b as Bookmark & { ai?: boolean }).ai !== false).map(b => ({ title: b.title, url: b.url }));
      }
      case 'watch_status': {
        const [watches, states] = await Promise.all([ctx.store.watches(ctx.uid), ctx.store.states(ctx.uid)]);
        if (!Array.isArray(watches) || watches.length > 2000 || !(states instanceof Map)
          || watches.some(w => !plainObject(w) || typeof w.label !== 'string' || w.label.length > 200)) throw new AgentStop('invalid_result');
        return watches.map(w => {
          const s = states.get(w.id);
          if (s && (!['ok', 'error'].includes(s.status) || (s.summary !== undefined && typeof s.summary !== 'string'))) throw new AgentStop('invalid_result');
          return { name: w.label, from: routeOf(s, w) === 'local' ? 'PC' : 'GitHub', status: s?.status ?? 'not checked', lastChange: s?.summary ?? null };
        });
      }
      case 'propose_complete': {
        const c = await resolve(args.card ?? args.id, 'reminder', true);
        if (!isCard(c)) return c;
        propose({ kind: 'complete', cardId: c.id, title: c.title, revision: c.revision });
        return { proposed: true };
      }
      case 'propose_move': {
        const c = await resolve(args.card ?? args.id, 'reminder');
        if (!isCard(c)) return c;
        if (!validDate(args.due_date)) return { error: 'due_date must be YYYY-MM-DD.' };
        propose({ kind: 'update', cardId: c.id, title: c.title, revision: c.revision, changes: { dueDate: args.due_date } });
        return { proposed: true };
      }
      case 'propose_rename': {
        const c = await resolve(args.card ?? args.id), title = String(args.title ?? '').trim();
        if (!isCard(c)) return c;
        if (!title || title.length > LIMITS.title) return { error: `title must be 1-${LIMITS.title} characters.` };
        propose({ kind: 'update', cardId: c.id, title: c.title, revision: c.revision, changes: { title } });
        return { proposed: true };
      }
      case 'propose_delete': {
        const c = await resolve(args.card ?? args.id);
        if (!isCard(c)) return c;
        propose({ kind: 'delete', cardId: c.id, title: c.title, revision: c.revision, cardKind: c.kind });
        return { proposed: true };
      }
      case 'propose_reminder': {
        const title = String(args.title ?? '').trim();
        if (!title || title.length > LIMITS.title) return { error: `title must be 1-${LIMITS.title} characters.` };
        if (args.due_date !== undefined && args.due_date !== '' && !validDate(args.due_date)) return { error: 'due_date must be YYYY-MM-DD.' };
        propose({ kind: 'reminder', title, body: '', dueDate: validDate(args.due_date) ? args.due_date : '' });
        return { proposed: true };
      }
      case 'propose_note': {
        const title = String(args.title ?? '').trim();
        if (!title || title.length > LIMITS.title) return { error: `title must be 1-${LIMITS.title} characters.` };
        propose({ kind: 'note', title, body: String(args.body ?? '').slice(0, LIMITS.body) });
        return { proposed: true };
      }
      default: return { error: `Unknown tool ${name}.` };
    }
  }

  try {
    budget.check();
    if (typeof question !== 'string' || !question.trim() || question.length > LIMITS_AGENT.questionChars) throw new AgentStop('invalid_input');
    let ollama: ReturnType<typeof validateLocalModel>;
    try { ollama = validateLocalModel(ctx.ollama); } catch { throw new AgentStop('invalid_input'); }
    if (!realDate(ctx.today)) throw new AgentStop('invalid_input');
    const open = (await cards()).filter(c => c.kind === 'reminder' && !c.done)
      .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 30);
    const messages: Record<string, unknown>[] = [{ role: 'system', content: systemPrompt(ctx.today, ctx.timeZone, open) }, { role: 'user', content: question }];
    for (let round = 0; round < LIMITS_AGENT.rounds; round++) {
      budget.check();
      const body = JSON.stringify({ model: ollama.model, messages, tools: TOOLS, stream: false, think: false,
        options: { temperature: 0.2, num_ctx: 8192, num_predict: LIMITS_AGENT.outputTokens } });
      const size = Buffer.byteLength(body);
      if (size > LIMITS_AGENT.requestBytes || usage.inputBytes + size > LIMITS_AGENT.inputBytes) throw new AgentStop('input_limit');
      usage.inputBytes += size; usage.rounds++;
      const response = await budget.wait(() => fetcher(`${ollama.url}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: budget.signal, redirect: 'error', body,
      }));
      if (!response.ok) throw new AgentStop('model_unavailable');
      const text = await budget.wait(() => boundedText(response, LIMITS_AGENT.responseBytes, budget.signal));
      usage.responseBytes += Buffer.byteLength(text);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new AgentStop('invalid_response'); }
      const reply = modelReply(raw), calls = reply.tool_calls;
      if (!calls.length) {
        if (!reply.content.trim()) throw new AgentStop('invalid_response');
        const answer = confirmationAnswer(toTelegramHtml(reply.content), proposals.length);
        return { status: 'complete', answer, proposals, toolCalls, trace, usage };
      }
      if (toolCalls + calls.length > LIMITS_AGENT.tools) throw new AgentStop('tool_limit');
      messages.push({ role: 'assistant', content: reply.content, tool_calls: calls });
      for (const call of calls) {
        budget.check(); toolCalls++;
        const name = call.function.name;
        let args: Record<string, unknown>, result: unknown;
        try { args = parseToolArguments(name, call.function.arguments); }
        catch (error) {
          // Parser messages are fixed text; never echo raw arguments back into diagnostics.
          messages.push({ role: 'tool', tool_name: name, content: JSON.stringify({ error: (error as Error).message }) });
          trace.push('invalid_arguments'); continue;
        }
        trace.push(name);
        try { result = await budget.wait(() => run(name, args)); }
        catch (error) { if (error instanceof AgentStop) throw error; result = { error: 'That lookup failed; its result is unavailable.' }; }
        budget.check();
        messages.push({ role: 'tool', tool_name: name, content: toolResult(result) });
      }
    }
    throw new AgentStop('round_limit');
  } catch (error) {
    const status = error instanceof AgentStop ? error.reason : budget.signal.aborted
      ? (budget.signal.reason as AgentStop).reason : 'model_unavailable';
    const answer = status === 'model_unavailable' ? "I couldn't reach the AI on your PC. Check that Ollama and the selected model are available, then ask again."
      : status === 'lookup_failed' ? 'I could not read your workspace data. Try again shortly. No changes were proposed.'
      : status === 'deadline' ? 'That took too long. Try a smaller question. No changes were proposed.'
      : status === 'cancelled' ? 'That request was cancelled. No changes were proposed.'
      : status === 'invalid_input' ? 'Please send a shorter, non-empty question.'
      : 'I could not complete that request within its validation and size limits. Try a more specific question. No changes were proposed.';
    // Discard partial proposals on any terminal failure; nothing was persisted or executed.
    return { status, answer, proposals: [], toolCalls, trace, usage };
  } finally { budget.close(); }
}

export { formatDue };
