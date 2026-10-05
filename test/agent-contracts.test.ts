import { describe, expect, it, vi } from 'vitest';
import { answerQuestion, toTelegramHtml, type AgentContext } from '../src/agent.ts';
import { parseToolArguments } from '../src/agent-contracts.ts';
import { LIMITS_AGENT, toolResult } from '../src/agent-policy.ts';
import { DEFAULT_OLLAMA, localModel, validateLocalModel } from '../src/local-model.ts';

const call = (name: string, args: unknown) => ({ function: { name, arguments: args } });
const envelope = (message: object) => ({ done: true, done_reason: 'stop', message: { role: 'assistant', ...message } });
function context(replies: unknown[] = [envelope({ content: 'Synthetic answer' })]) {
  const requests: any[] = [], signals: AbortSignal[] = [];
  const ctx: AgentContext = {
    uid: 'synthetic', today: '2026-10-05', timeZone: 'Asia/Singapore', calendars: [], ollama: { url: 'http://localhost:11434', model: 'synthetic' },
    store: { cards: async () => [], unreadBookmarks: async () => [], watches: async () => [], states: async () => new Map() } as unknown as AgentContext['store'],
    fetcher: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body))); signals.push(init?.signal as AbortSignal);
      return new Response(JSON.stringify(replies.shift() ?? envelope({ content: 'Done' })));
    }) as typeof fetch,
  };
  return { ctx, requests, signals };
}

describe('closed tool contracts', () => {
  it.each([
    ['propose_note', '{'], ['propose_note', null], ['propose_note', []],
    ['propose_note', { title: { secret: 'private text' } }], ['propose_note', { title: 'ok', extra: true }],
    ['propose_note', { title: 'ok', body: 123 }], ['propose_note', { title: 'ok', body: 'x'.repeat(10001) }],
    ['propose_reminder', { title: 'ok', due_date: '2026-02-30' }],
    ['propose_move', { card: 'x', due_date: '2026-04-31' }], ['propose_complete', {}],
    ['propose_complete', { id: 'x', card: 'x' }], ['search_cards', { query: [] }],
    ['list_reminders', { when: 'sometimes' }], ['list_reminders', { when: 'today', from: '2026-10-05' }],
    ['calendar_events', { from: '2026-10-05', to: '2026-10-04' }],
    ['calendar_events', { from: '2026-01-01', to: '2026-12-31' }], ['reading_list', { query: 'x' }], ['unknown', {}],
  ])('rejects invalid arguments before proposal creation: %s', async (name, args) => {
    expect(() => parseToolArguments(name as string, args)).toThrow();
    const f = context([envelope({ tool_calls: [call(name as string, args)] }), envelope({ content: 'Cannot do that.' })]);
    const result = await answerQuestion('Synthetic request', f.ctx);
    expect(result.proposals).toEqual([]); expect(result.trace).toEqual(['invalid_arguments']);
    expect(f.requests[1].messages.at(-1).content).toContain('error');
    expect(result.trace.join('')).not.toContain('private text');
  });
  it('accepts leap days, explicit legacy IDs and valid JSON objects', () => {
    expect(parseToolArguments('propose_move', '{"id":"x","due_date":"2028-02-29"}')).toEqual({ id: 'x', due_date: '2028-02-29' });
    expect(() => parseToolArguments('propose_note', Object.assign(new Date(), { title: 'x' }))).toThrow();
    expect(() => parseToolArguments('reading_list', '{"__proto__":{}}')).toThrow();
  });
});

describe('bounded agent execution', () => {
  it.each([
    { done: false, message: { role: 'assistant', content: 'partial' } },
    { done: true, message: { role: 'user', content: 'wrong role' } },
    { done: true, message: { role: 'assistant', content: {} } },
    { message: { role: 'assistant', content: 'missing finish' } },
    { done: true, message: { role: 'assistant', tool_calls: [{}] } },
  ])('rejects malformed or incomplete model envelopes', async raw => {
    const result = await answerQuestion('Synthetic', context([raw]).ctx);
    expect(result.status).toBe('invalid_response'); expect(result.proposals).toEqual([]);
  });
  it('never offers calls from an output-limited response', async () => {
    const result = await answerQuestion('Synthetic', context([{ ...envelope({ tool_calls: [call('propose_note', { title: 'Do not save' })] }), done_reason: 'length' }]).ctx);
    expect(result.status).toBe('output_limit'); expect(result.toolCalls).toBe(0); expect(result.proposals).toEqual([]);
  });
  it('bounds the actual response stream without trusting Content-Length', async () => {
    const f = context(); let cancelled = false;
    f.ctx.fetcher = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(40000)); }, cancel() { cancelled = true; } }));
    const result = await answerQuestion('Synthetic', f.ctx);
    expect(result.status).toBe('output_limit'); expect(cancelled).toBe(true);
  });
  it('does not silently truncate oversized input', async () => {
    const f = context();
    expect((await answerQuestion('x'.repeat(4001), f.ctx)).status).toBe('invalid_input');
    expect(f.requests).toHaveLength(0);
  });
  it('expires even when the initial database read never returns', async () => {
    vi.useFakeTimers();
    try {
      const f = context(); f.ctx.store.cards = () => new Promise(() => {});
      const waiting = answerQuestion('Synthetic', f.ctx);
      await vi.advanceTimersByTimeAsync(LIMITS_AGENT.deadlineMs + 1);
      expect((await waiting).status).toBe('deadline'); expect(f.requests).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('propagates cancellation into model fetches and discards earlier proposals', async () => {
    const f = context(), cancel = new AbortController(); f.ctx.signal = cancel.signal;
    let calls = 0, captured: AbortSignal | undefined;
    f.ctx.fetcher = async (_u, init) => {
      captured = init?.signal as AbortSignal;
      if (++calls === 1) return new Response(JSON.stringify(envelope({ tool_calls: [call('propose_note', { title: 'Partial' })] })));
      cancel.abort(); return new Promise(() => {});
    };
    const result = await answerQuestion('Synthetic', f.ctx);
    expect(result.status).toBe('cancelled'); expect(result.proposals).toEqual([]); expect(captured?.aborted).toBe(true);
  });
  it('propagates cancellation to calendar fetches, without treating it as an empty calendar', async () => {
    const f = context([envelope({ tool_calls: [call('calendar_events', { from: '2026-10-05', to: '2026-10-06' })] })]);
    const cancel = new AbortController(), modelFetch = f.ctx.fetcher!; f.ctx.signal = cancel.signal; f.ctx.calendars = ['https://example.test/synthetic.ics'];
    let calendarSignal: AbortSignal | undefined;
    f.ctx.fetcher = async (url, init) => {
      if (String(url).includes('/api/chat')) return modelFetch(url, init);
      calendarSignal = init?.signal as AbortSignal; cancel.abort(); return new Promise(() => {});
    };
    expect((await answerQuestion('Synthetic', f.ctx)).status).toBe('cancelled'); expect(calendarSignal?.aborted).toBe(true);
  });
  it('enforces both round and tool limits and discards unfinished proposals', async () => {
    const tooMany = Array.from({ length: 9 }, () => call('propose_note', { title: 'Synthetic' }));
    expect((await answerQuestion('Synthetic', context([envelope({ tool_calls: tooMany })]).ctx)).status).toBe('tool_limit');
    const endless = Array.from({ length: 4 }, () => envelope({ tool_calls: [call('propose_note', { title: 'Synthetic' })] }));
    const result = await answerQuestion('Synthetic', context(endless).ctx);
    expect(result.status).toBe('round_limit'); expect(result.proposals).toEqual([]); expect(result.toolCalls).toBe(4);
  });
  it('counts schemas, context and repeated history towards the cumulative byte budget', async () => {
    const f = context(Array.from({ length: 4 }, () => envelope({ tool_calls: [call('reading_list', {})] })));
    f.ctx.store.cards = async () => Array.from({ length: 30 }, (_, i) => ({ id: 'c' + i, kind: 'reminder', title: 'x'.repeat(120), body: '', url: '', dueDate: '2026-10-06', done: false, revision: 0 } as any));
    const result = await answerQuestion('\u754c'.repeat(3200), f.ctx);
    expect(result.status).toBe('input_limit');
    expect(result.usage.inputBytes).toBe(f.requests.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0));
    expect(result.usage.inputBytes).toBeLessThanOrEqual(LIMITS_AGENT.inputBytes);
    expect(f.requests.length).toBeGreaterThan(1);
  });
  it('rejects invalid stored evidence and keeps ai:false cards out of context', async () => {
    const f = context(); f.ctx.store.cards = async () => [{ id: 'secret', ai: false, title: 'excluded' }] as any;
    expect((await answerQuestion('Synthetic', f.ctx)).status).toBe('complete');
    expect(JSON.stringify(f.requests)).not.toContain('excluded');
    f.ctx.store.cards = async () => [{ id: 'bad', title: {} }] as any;
    expect((await answerQuestion('Synthetic', f.ctx)).status).toBe('invalid_result');
  });
  it('distinguishes a workspace read outage from a model outage', async () => {
    const f = context(); f.ctx.store.cards = async () => { throw new Error('private database error'); };
    const result = await answerQuestion('Synthetic', f.ctx);
    expect(result.status).toBe('lookup_failed'); expect(result.answer).toContain('workspace data');
    expect(JSON.stringify(result)).not.toContain('private database error'); expect(f.requests).toHaveLength(0);
  });
  it('returns valid JSON with explicit coverage rather than sliced JSON', () => {
    const result = JSON.parse(toolResult(Array.from({ length: 100 }, () => ({ title: 'x'.repeat(200) }))));
    expect(result).toMatchObject({ total: 100, truncated: true }); expect(result.shown).toBe(result.items.length);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LIMITS_AGENT.resultBytes);
    expect(() => toolResult({ value: NaN })).toThrow('invalid_result');
    expect(() => toolResult({ title: undefined })).toThrow('invalid_result');
    expect(toTelegramHtml('**' + '<'.repeat(4000) + '**')).not.toContain('<b>');
  });
});

describe('local model configuration', () => {
  it('uses explicit environment values then legacy defaults, without Firestore', () => {
    expect(localModel({})).toEqual(DEFAULT_OLLAMA);
    expect(localModel({ WATCHER_OLLAMA_MODEL: 'synthetic:small' })).toEqual({ ...DEFAULT_OLLAMA, model: 'synthetic:small' });
    expect(localModel({ WATCHER_OLLAMA_URL: 'http://127.0.0.1:9999' }).url).toBe('http://127.0.0.1:9999');
  });
  it.each(['https://example.com', 'http://localhost.evil.test', 'http://user:secret@localhost:11434', 'http://localhost:11434/api', 'http://localhost:11434?token=secret'])('refuses invalid explicit endpoints: %s', async url => {
    expect(() => validateLocalModel({ url, model: 'synthetic' })).toThrow();
    const f = context(); f.ctx.ollama.url = url;
    expect((await answerQuestion('Synthetic', f.ctx)).status).toBe('invalid_input'); expect(f.requests).toHaveLength(0);
  });
});
