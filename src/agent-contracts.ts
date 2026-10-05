import { LIMITS } from './capture.ts';
import { realDate } from './confirmations.ts';
import { AgentStop, LIMITS_AGENT, plainObject } from './agent-policy.ts';

const fields: Record<string, string[]> = {
  list_reminders: ['when', 'from', 'to'], search_cards: ['query', 'kind'], calendar_events: ['from', 'to'],
  reading_list: [], watch_status: [], propose_complete: ['card', 'id'], propose_move: ['card', 'id', 'due_date'],
  propose_rename: ['card', 'id', 'title'], propose_delete: ['card', 'id'], propose_reminder: ['title', 'due_date'], propose_note: ['title', 'body'],
};
const required: Record<string, string[]> = { search_cards: ['query'], calendar_events: ['from', 'to'], propose_move: ['due_date'],
  propose_rename: ['title'], propose_reminder: ['title'], propose_note: ['title'] };
const str = (v: unknown, max: number, empty = false) => typeof v === 'string' && v.length <= max && (empty || !!v.trim());

export function parseToolArguments(name: string, raw: unknown): Record<string, unknown> {
  if (!Object.hasOwn(fields, name)) throw new Error('Unknown tool. Use one of the supplied tool names.');
  let args = raw;
  if (typeof raw === 'string') {
    if (raw.length > 16000) throw new Error('Tool arguments are too large.');
    try { args = JSON.parse(raw); } catch { throw new Error('Tool arguments must be valid JSON.'); }
  }
  if (!plainObject(args)) throw new Error('Tool arguments must be an object.');
  if (Object.keys(args).some(k => !fields[name].includes(k)) || (required[name] ?? []).some(k => !Object.hasOwn(args, k))) throw new Error('Tool arguments contain missing or unknown fields.');
  for (const [k, v] of Object.entries(args)) {
    if (['from', 'to', 'due_date'].includes(k)) {
      if (!(name === 'propose_reminder' && k === 'due_date' && v === '') && !realDate(v)) throw new Error('Use a real calendar date in YYYY-MM-DD form.');
    } else if (k === 'when') {
      if (!['overdue', 'today', 'tomorrow', 'this_week', 'upcoming', 'done', 'all'].includes(v as string)) throw new Error('Invalid reminder range.');
    } else if (k === 'kind') {
      if (!['note', 'link', 'reminder'].includes(v as string)) throw new Error('Invalid card kind.');
    } else if (!str(v, k === 'body' ? LIMITS.body : k === 'title' ? LIMITS.title : k === 'id' ? 100 : 200, k === 'body')) throw new Error('Tool text has an invalid type or length.');
  }
  if (fields[name].includes('card') && (Number(Object.hasOwn(args, 'card')) + Number(Object.hasOwn(args, 'id')) !== 1)) throw new Error('Supply exactly one card reference: card or id.');
  if (args.when !== undefined && (args.from !== undefined || args.to !== undefined)) throw new Error('Choose when or a date range, not both.');
  if (args.from !== undefined && args.to !== undefined) {
    const days = (Date.parse(args.to as string) - Date.parse(args.from as string)) / 86400000;
    if (days < 0 || days > (name === 'calendar_events' ? 62 : 366)) throw new Error('Date range is reversed or too wide.');
  }
  return args;
}

export interface ModelReply { content: string; tool_calls: { function: { name: string; arguments: unknown } }[] }
export function modelReply(value: unknown): ModelReply {
  if (!plainObject(value)) throw new AgentStop('invalid_response');
  if (value.done_reason === 'length') throw new AgentStop('output_limit');
  if (value.done !== true || (value.done_reason !== undefined && value.done_reason !== 'stop') || !plainObject(value.message)) throw new AgentStop('invalid_response');
  const m = value.message;
  if (m.role !== 'assistant' || (m.content !== undefined && typeof m.content !== 'string')
    || (m.tool_calls !== undefined && !Array.isArray(m.tool_calls))) throw new AgentStop('invalid_response');
  const calls = (m.tool_calls ?? []) as unknown[];
  if (calls.length > LIMITS_AGENT.tools) throw new AgentStop('tool_limit');
  for (const c of calls) if (!plainObject(c) || !plainObject(c.function) || typeof c.function.name !== 'string'
    || c.function.name.length > 64 || !Object.hasOwn(c.function, 'arguments')) throw new AgentStop('invalid_response');
  return { content: (m.content ?? '') as string, tool_calls: calls as ModelReply['tool_calls'] };
}
