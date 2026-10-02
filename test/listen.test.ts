import { describe, expect, it } from 'vitest';
import { drainOnce, makeHandler, makeQueue, parseCommand, pollOnce, type CaptureStore, type ListenDeps, type NewBookmark, type NewCard, type Pending, type Update } from '../src/listen.ts';
import type { ItemsDoc, Store, Watch, WatchState } from '../src/run.ts';

const UID = 'owner1', CHAT = '4242', TOKEN = 'T';
const watch = (over: Partial<Watch> = {}): Watch => ({ id: 'w1', label: 'EX13 singles', url: 'https://shop.example/ex13', selector: '.item', ignore: '', interval: 5, enabled: true, createdAt: 1, runOn: 'local', ...over });

function setup(watches: Watch[], seed: Record<string, WatchState> = {}) {
  const states = new Map(Object.entries(seed)), items = new Map<string, ItemsDoc>();
  let inbox: Record<string, Pending> = {};
  const cards: NewCard[] = [], bookmarks: NewBookmark[] = [];
  const store: Store & CaptureStore = {
    watches: async () => watches, states: async () => new Map(states), items: async () => new Map(items),
    save: async (_u, id, state, doc) => { states.set(id, state); if (doc) items.set(id, doc); },
    removeItems: async () => {}, heartbeat: async () => {},
    settings: async () => ({ timezone: 'Asia/Singapore' }),
    inbox: async () => structuredClone(inbox), saveInbox: async (_u, pending) => { inbox = structuredClone(pending); },
    createCard: async (_u, card) => { cards.push(card); }, createBookmark: async (_u, bookmark) => { bookmarks.push(bookmark); },
  };
  let clock = 1_800_000_000_000;
  const sent: string[] = [], pages: string[] = [], edits: string[] = [], buttons: unknown[] = [];
  let offsets: number[] = [];
  let pendingUpdates: Update[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`https://api.telegram.org/bot${TOKEN}/sendMessage`)) {
      const body = JSON.parse(String(init?.body));
      expect(body.chat_id).toBe(CHAT);
      sent.push(body.text);
      if (body.reply_markup) buttons.push(body.reply_markup.inline_keyboard);
      return new Response('{"ok":true}');
    }
    if (url.includes('/editMessageText')) { edits.push(JSON.parse(String(init?.body)).text); return new Response('{"ok":true}'); }
    if (url.includes('/answerCallbackQuery')) return new Response('{"ok":true}');
    if (url.includes('/getUpdates')) {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      const result = pendingUpdates.filter(u => u.update_id >= offset);
      return new Response(JSON.stringify({ ok: true, result }));
    }
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    pages.push(url);
    return new Response('<div class="item">EX13-001 Agumon</div>', { headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  const deps: ListenDeps = { token: TOKEN, owners: { [UID]: CHAT }, store, fetcher, now: () => clock, base: { fetcher, now: () => clock, sleep: async ms => { clock += ms; } } };
  const handle = makeHandler(deps, makeQueue());
  const message = (text: string, chat = Number(CHAT), age = 0): Update => ({ update_id: 1, message: { date: Math.floor(clock / 1000) - age, text, chat: { id: chat } } });
  const tap = (data: string, chat = Number(CHAT)): Update => ({ update_id: 2, callback_query: { id: 'cb', data, message: { message_id: 77, chat: { id: chat } } } });
  const lastButtons = () => buttons.at(-1) as { text: string; callback_data: string }[][];
  return { deps, handle, message, tap, sent, edits, pages, states, cards, bookmarks, lastButtons, inbox: () => inbox,
    queue: (updates: Update[]) => { pendingUpdates = updates; }, offsets: () => offsets, advance: (ms: number) => { clock += ms; } };
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

describe('quick capture', () => {
  // The fake clock starts at 1_800_000_000_000 ms: Friday 15 January 2027, 16:00 in Singapore.
  it('proposes a reminder with a parsed due date and saves it only after Save', async () => {
    const s = setup([]);
    await s.handle(s.message('remind me to file the brief Monday'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nSave this reminder?\n<b>File the brief</b>\nDue: Mon 18 Jan');
    expect(s.cards).toEqual([]);
    const [[save, cancel]] = s.lastButtons();
    expect([save.text, cancel.text]).toEqual(['Save', 'Cancel']);
    await s.handle(s.tap(save.callback_data));
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]).toMatchObject({ kind: 'reminder', title: 'File the brief', body: '', url: '', dueDate: '2027-01-18', done: false, pinned: false, tone: 'cream', revision: 0 });
    expect(Object.keys(s.cards[0]).sort()).toEqual(['body', 'createdAt', 'done', 'dueDate', 'id', 'kind', 'pinned', 'revision', 'title', 'tone', 'updatedAt', 'url']);
    expect(s.edits.at(-1)).toContain('Saved to My Space ✓');
    expect(s.inbox()).toEqual({});
    // Tapping again does nothing more.
    await s.handle(s.tap(save.callback_data));
    expect(s.cards).toHaveLength(1);
    expect(s.edits.at(-1)).toContain('expired or was already handled');
  });

  it('cancels, saves notes and reading-list links, and ignores other chats', async () => {
    const s = setup([]);
    await s.handle(s.message('note: book the venue\nfor 40 people'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nSave this note to My Space?\n<b>Book the venue</b>\nfor 40 people');
    await s.handle(s.tap(s.lastButtons()[0][1].callback_data));
    expect(s.edits.at(-1)).toContain("OK, I didn't save it.");
    await s.handle(s.message('https://example.com/article?id=1'));
    expect(s.sent.at(-1)).toContain('Add to your reading list?\n<b>example.com</b>');
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data, 999)); // a stranger's tap
    expect(s.bookmarks).toEqual([]);
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.bookmarks[0]).toMatchObject({ url: 'https://example.com/article?id=1', title: 'example.com', snippet: '', tags: [], status: 'unread', revision: 0 });
    expect(s.cards).toEqual([]);
    await s.handle(s.message('remind me to call mum', 999));
    expect(s.inbox()).toEqual({});
  });

  it('accepts capture messages sent while the PC was off, but forgets proposals after a day', async () => {
    const s = setup([]);
    await s.handle(s.message('remind me to pay rent tomorrow', Number(CHAT), 3 * 3600));
    expect(s.sent.at(-1)).toContain('<b>Pay rent</b>\nDue: tomorrow');
    const save = s.lastButtons()[0][0].callback_data;
    s.advance(25 * 3_600_000);
    await s.handle(s.tap(save));
    expect(s.cards).toEqual([]);
    expect(s.edits.at(-1)).toContain('expired');
  });

  it('explains unclear messages', async () => {
    const s = setup([]);
    await s.handle(s.message('remind me to'));
    expect(s.sent.at(-1)).toContain('What should I remind you about?');
    await s.handle(s.message('what is the weather'));
    expect(s.sent.at(-1)).toContain("I didn't catch that");
  });

  it('in the cloud, answers messages, declines /check, and acknowledges what it handled', async () => {
    const s = setup([watch()]);
    const now = Math.floor(1_800_000_000_000 / 1000);
    s.queue([
      { update_id: 41, message: { date: now, text: '/check', chat: { id: Number(CHAT) } } },
      { update_id: 42, message: { date: now, text: 'remind me to water plants today', chat: { id: Number(CHAT) } } },
    ]);
    await drainOnce(s.deps);
    expect(s.pages).toEqual([]);
    expect(s.sent[0]).toContain("Your PC is off or asleep, so I can't check its watches");
    expect(s.sent[1]).toContain('<b>Water plants</b>\nDue: today');
    expect(s.offsets()).toEqual([0, 43]); // the second call confirms both updates
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
    const next = await pollOnce({ token: TOKEN, owners: {}, store: {} as ListenDeps['store'], base: {}, fetcher }, 0, async update => { handled.push(update.update_id); }, 0);
    expect(next).toBe(10);
    expect(handled).toEqual([7, 9]);
  });
});
