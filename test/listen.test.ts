import { describe, expect, it } from 'vitest';
import { makeHandler, makeQueue, parseCommand, pollOnce, type ListenDeps, type Update } from '../src/listen.ts';
import type { ItemsDoc, Store, Watch, WatchState } from '../src/run.ts';

const UID = 'owner1', CHAT = '4242', TOKEN = 'T';
const watch = (over: Partial<Watch> = {}): Watch => ({ id: 'w1', label: 'EX13 singles', url: 'https://shop.example/ex13', selector: '.item', ignore: '', interval: 5, enabled: true, createdAt: 1, runOn: 'local', ...over });

function setup(watches: Watch[], seed: Record<string, WatchState> = {}) {
  const states = new Map(Object.entries(seed)), items = new Map<string, ItemsDoc>();
  const store: Store = {
    watches: async () => watches, states: async () => new Map(states), items: async () => new Map(items),
    save: async (_u, id, state, doc) => { states.set(id, state); if (doc) items.set(id, doc); },
    removeItems: async () => {}, heartbeat: async () => {},
  };
  let clock = 1_800_000_000_000;
  const sent: string[] = [], pages: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`https://api.telegram.org/bot${TOKEN}/sendMessage`)) {
      const body = JSON.parse(String(init?.body));
      expect(body.chat_id).toBe(CHAT);
      sent.push(body.text);
      return new Response('{"ok":true}');
    }
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    pages.push(url);
    return new Response('<div class="item">EX13-001 Agumon</div>', { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const deps: ListenDeps = { token: TOKEN, owners: { [UID]: CHAT }, store, fetcher, now: () => clock, base: { fetcher, now: () => clock, sleep: async ms => { clock += ms; } } };
  const handle = makeHandler(deps, makeQueue());
  const message = (text: string, chat = Number(CHAT), age = 0): Update => ({ update_id: 1, message: { date: Math.floor(clock / 1000) - age, text, chat: { id: chat } } });
  return { deps, handle, message, sent, pages, states, advance: (ms: number) => { clock += ms; } };
}

describe('commands', () => {
  it('parses slash commands, bot mentions and plain words', () => {
    expect(parseCommand('/check')).toEqual({ name: 'check', filter: '' });
    expect(parseCommand('/check@aeonofvoracity_bot ex13')).toEqual({ name: 'check', filter: 'ex13' });
    expect(parseCommand('check EX13 singles')).toEqual({ name: 'check', filter: 'EX13 singles' });
    expect(parseCommand('/status')).toEqual({ name: 'status' });
    expect(parseCommand('/start')).toEqual({ name: 'help' });
    expect(parseCommand('hello there')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it('ignores everyone except the owner', async () => {
    const s = setup([watch()]);
    await s.handle(s.message('/check', 999));
    expect(s.sent).toEqual([]);
    expect(s.pages).toEqual([]);
  });

  it('does not run commands sent while the PC was off', async () => {
    const s = setup([watch()]);
    await s.handle(s.message('/check', Number(CHAT), 3600));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain("Your PC was off when you sent that");
    expect(s.pages).toEqual([]);
  });

  it('/check checks PC watches now, mentions GitHub ones, and summarises', async () => {
    const s = setup([watch(), watch({ id: 'w2', label: 'News', url: 'https://news.example/', runOn: 'auto' })]);
    await s.handle(s.message('/check'));
    expect(s.pages).toEqual(['https://shop.example/ex13']);
    expect(s.sent[0]).toBe('Doot Doot.\nChecking now…');
    expect(s.sent.some(text => text.includes('Now watching <b>EX13 singles</b>'))).toBe(true);
    const summary = s.sent.at(-1)!;
    expect(summary).toContain('Checked 1 of 1:');
    expect(summary).toContain('👀 <b>EX13 singles</b>: now watching (1 item)');
    expect(summary).toContain('GitHub checks <b>News</b> on its own schedule');
  });

  it('respects the one-minute cooldown and backoff, and filters by name', async () => {
    const s = setup([watch(), watch({ id: 'w2', label: 'BT26 singles', url: 'https://shop.example/bt26' })],
      { w2: { status: 'error', checkedAt: 0, error: 'the site asked us to slow down (HTTP 429)', failures: 1, retryAt: 1_800_000_000_000 + 3_600_000, route: 'local' } });
    await s.handle(s.message('/check'));
    expect(s.pages).toEqual(['https://shop.example/ex13']);
    expect(s.sent.at(-1)).toMatch(/⏳ <b>BT26 singles<\/b>: backing off until \d\d:\d\d \(the site asked us to slow down/);
    s.advance(10_000);
    await s.handle(s.message('/check ex13'));
    expect(s.pages).toHaveLength(1);
    expect(s.sent.at(-1)).toContain('⏳ <b>EX13 singles</b>: checked less than a minute ago');
    await s.handle(s.message('/check pokemon'));
    expect(s.sent.at(-1)).toContain('No watch on your PC matches “pokemon”.');
    s.advance(60_000);
    await s.handle(s.message('/check ex13'));
    expect(s.pages).toHaveLength(2);
    expect(s.sent.at(-1)).toContain('✓ <b>EX13 singles</b>: no change (1 item)');
  });

  it('/status lists each watch with where and when it was checked', async () => {
    const s = setup([watch(), watch({ id: 'w2', label: 'News', runOn: 'auto', enabled: false })],
      { w1: { status: 'ok', checkedAt: 1_800_000_000_000 - 120_000, itemCount: 12, changedAt: 1_800_000_000_000 - 7_200_000, summary: '12 new' } });
    await s.handle(s.message('/status'));
    expect(s.sent[0]).toBe('Doot Doot.\n• <b>EX13 singles</b>, from your PC: checked 2 min ago, 12 items; changed 2 h ago (12 new)\n• <b>News</b> (paused), from GitHub: not checked yet');
  });

  it('answers /help and unknown messages', async () => {
    const s = setup([]);
    await s.handle(s.message('/help'));
    await s.handle(s.message('what?'));
    expect(s.sent[0]).toContain('/check: check your PC watches now');
    expect(s.sent[1]).toContain("I didn't catch that");
  });
});

describe('queue and polling', () => {
  it('runs jobs one at a time, in order, even when one fails', async () => {
    const enqueue = makeQueue(), order: string[] = [];
    const slow = enqueue(async () => { await new Promise(r => setTimeout(r, 20)); order.push('scheduled'); });
    const failing = enqueue(async () => { order.push('broken'); throw new Error('x'); });
    const manual = enqueue(async () => { order.push('manual'); });
    await Promise.allSettled([slow, failing, manual]);
    expect(order).toEqual(['scheduled', 'broken', 'manual']);
  });

  it('advances the offset past every update', async () => {
    const handled: number[] = [];
    const fetcher = (async () => new Response(JSON.stringify({ ok: true, result: [{ update_id: 7 }, { update_id: 9 }] }))) as unknown as typeof fetch;
    const next = await pollOnce({ token: TOKEN, owners: {}, store: {} as Store, base: {}, fetcher }, 0, async update => { handled.push(update.update_id); }, 0);
    expect(next).toBe(10);
    expect(handled).toEqual([7, 9]);
  });
});
