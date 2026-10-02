import { describe, expect, it } from 'vitest';
import { answerQuestion, confirmationAnswer, localOllamaUrl, toTelegramHtml } from '../src/agent.ts';
import { doneButtons } from '../src/assistant.ts';
import { matchCards, parseEdit, planEdit, type CardDoc } from '../src/edit.ts';

const TODAY = '2026-10-02';
const card = (id: string, title: string, over: Partial<CardDoc> = {}): CardDoc =>
  ({ id, kind: 'reminder', title, body: '', url: '', dueDate: '2026-10-05', done: false, pinned: false, tone: 'cream', createdAt: 1, updatedAt: 1, revision: 2, ...over });

describe('edit commands', () => {
  it('parses /done, /delete, /move and /due', () => {
    expect(parseEdit('/done file the brief')).toEqual({ name: 'done', query: 'file the brief' });
    expect(parseEdit('/delete@aeonofvoracity_bot old note')).toEqual({ name: 'delete', query: 'old note' });
    expect(parseEdit('/move pay rent to Monday')).toEqual({ name: 'move', query: 'pay rent', when: 'Monday' });
    expect(parseEdit('/due pay rent tomorrow')).toEqual({ name: 'move', query: 'pay rent tomorrow', when: '' });
    expect(parseEdit('/done')).toBeNull();
    expect(parseEdit('done with this')).toBeNull();
  });
  it('matches exact titles outright and otherwise offers close candidates', () => {
    const cards = [card('a', 'Pay rent'), card('b', 'Pay rent deposit'), card('c', 'Read chapter 7')];
    expect(matchCards(cards, 'pay rent').map(c => c.id)).toEqual(['a']);
    expect(matchCards(cards, 'pay').map(c => c.id).sort()).toEqual(['a', 'b']);
    expect(matchCards(cards, 'chapter seven').map(c => c.id)).toEqual(['c']);
    expect(matchCards(cards, 'tax')).toEqual([]);
  });
  it('plans changes only for suitable cards', () => {
    const cards = [card('a', 'Pay rent'), card('d', 'Pay rent', { done: true }), card('n', 'Rent ideas', { kind: 'note', dueDate: '' })];
    expect(planEdit({ name: 'done', query: 'pay rent' }, cards, TODAY).changes).toEqual([{ kind: 'complete', cardId: 'a', title: 'Pay rent', revision: 2 }]);
    expect(planEdit({ name: 'move', query: 'rent', when: 'tomorrow' }, cards, TODAY).changes.map(c => c.cardId).sort()).toEqual(['a', 'd']);
    expect(planEdit({ name: 'move', query: 'pay rent', when: 'tomorrow' }, cards, TODAY).changes[0]).toMatchObject({ kind: 'update', changes: { dueDate: '2026-10-03' } });
    expect(planEdit({ name: 'delete', query: 'rent ideas' }, cards, TODAY).changes[0]).toMatchObject({ kind: 'delete', cardId: 'n', cardKind: 'note' });
    expect(planEdit({ name: 'move', query: 'pay rent', when: 'someday' }, cards, TODAY).error).toContain('Which day?');
  });
});

describe('briefing buttons', () => {
  it('give one revision-checked ✓ per reminder, at most five, within the 64-byte limit', () => {
    const rows = doneButtons(Array.from({ length: 7 }, (_, i) => ({ id: crypto.randomUUID(), title: `Task ${i} with a rather long descriptive title`, dueDate: TODAY, revision: 12 })))!;
    expect(rows).toHaveLength(5);
    expect(rows[0][0].text).toMatch(/^✓ Task 0 .*…$/);
    expect(rows.every(([b]) => /^done:[0-9a-f-]{36}:12$/.test(b.data) && b.data.length <= 64)).toBe(true);
    expect(doneButtons([{ id: 'x', title: 'No revision', dueDate: TODAY }])).toBeUndefined();
  });
});

describe('local AI safeguards', () => {
  it('only ever talks to a model on this machine', () => {
    expect(localOllamaUrl('http://localhost:11434')).toBe('http://localhost:11434');
    expect(localOllamaUrl('http://127.0.0.1:9999/api')).toBe('http://127.0.0.1:9999');
    expect(localOllamaUrl('https://my-gpu.example.com')).toBe('http://localhost:11434');
    expect(localOllamaUrl('http://localhost.evil.com')).toBe('http://localhost:11434');
    expect(localOllamaUrl('file:///etc/passwd')).toBe('http://localhost:11434');
  });
  it('never lets the model claim a change before the owner confirms', () => {
    expect(confirmationAnswer('Rent has been moved to Monday.', 1)).toBe('Tap below to confirm.');
    expect(confirmationAnswer('Here are your options.', 2)).toBe('Here are your options.\n\nTap below to confirm each one.');
    expect(confirmationAnswer('Nothing due today.', 0)).toBe('Nothing due today.');
    expect(toTelegramHtml('<think>hmm</think>**Exam** <b>&')).toBe('<b>Exam</b> &lt;b&gt;&amp;');
  });
  it('asks which card when a name is ambiguous, and lists date ranges', async () => {
    const cards = [card('a', 'Pay rent', { dueDate: '2026-10-03' }), card('b', 'Pay rent deposit', { dueDate: '2026-10-08' }), card('x', 'Exam', { dueDate: '2026-10-09' })];
    const steps = [
      { tool_calls: [{ function: { name: 'propose_complete', arguments: { card: 'pay' } } }] },
      { tool_calls: [{ function: { name: 'list_reminders', arguments: { to: '2026-10-08' } } }] },
      { content: 'Which rent reminder?' },
    ];
    const seen: any[] = [];
    const fetcher = (async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message: steps[seen.length - 1] })); }) as unknown as typeof fetch;
    const result = await answerQuestion('mark pay done', { uid: 'u', today: TODAY, timeZone: 'Asia/Singapore', calendars: [], ollama: { url: 'http://localhost:11434', model: 'm' }, fetcher,
      store: { cards: async () => cards, unreadBookmarks: async () => [], watches: async () => [], states: async () => new Map() } as any });
    const ambiguous = JSON.parse(seen[1].messages.at(-1).content);
    expect(ambiguous.options.map((o: any) => o.title).sort()).toEqual(['Pay rent', 'Pay rent deposit']);
    expect(JSON.parse(seen[2].messages.at(-1).content).map((r: any) => r.title)).toEqual(['Pay rent', 'Pay rent deposit']);
    expect(seen[0].messages[0].content).toContain('2026-10-09  Exam');
    expect(seen[0].messages[0].content).toContain('Monday 2026-10-05');
    expect(result).toMatchObject({ answer: 'Which rent reminder?', proposals: [] });
  });
});
