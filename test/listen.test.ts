import { describe, expect, it } from 'vitest';
import type { Parcel } from '../src/parcels.ts';
import { drainOnce, relayRound, makeHandler, makeQueue, parseCommand, pollOnce, type CaptureStore, type ListenDeps, type NewBookmark, type NewCard, type Update } from '../src/listen.ts';
import type { ItemsDoc, Store, Watch, WatchState } from '../src/run.ts';
import type { CardDoc } from '../src/edit.ts';
import { memoryConfirmations } from './confirmation-memory.ts';

const UID = 'owner1', CHAT = '4242', TOKEN = 'T';
const watch = (over: Partial<Watch> = {}): Watch => ({ id: 'w1', label: 'EX13 singles', url: 'https://shop.example/ex13', selector: '.item', ignore: '', interval: 5, enabled: true, createdAt: 1, runOn: 'local', ...over });

const card = (over: Partial<CardDoc>): CardDoc => ({ id: 'c1', kind: 'reminder', title: 'File the brief', body: '', url: '', dueDate: '2027-01-15', done: false, pinned: false, tone: 'cream', createdAt: 1, updatedAt: 1, revision: 3, ...over });

function setup(watches: Watch[], seed: Record<string, WatchState> = {}, existing: CardDoc[] = [], ollama?: (body: any) => unknown) {
  const states = new Map(Object.entries(seed)), items = new Map<string, ItemsDoc>();
  const cards: NewCard[] = [], bookmarks: NewBookmark[] = [], parcels: Parcel[] = [];
  const myCards = existing.map(c => ({ ...c }));
  const confirmations = memoryConfirmations(cards, bookmarks, parcels, myCards);
  const store: Store & CaptureStore = {
    watches: async () => watches, states: async () => new Map(states), items: async () => new Map(items),
    save: async (_u, id, state, doc) => { states.set(id, state); if (doc) items.set(id, doc); },
    removeItems: async () => {}, heartbeat: async () => {},
    parcels: async () => parcels, parcelStates: async () => new Map([['p0', { registered: true, status: 'OutForDelivery' }]]),
    createParcel: async (_u, parcel) => { parcels.push(parcel); },
    settings: async () => ({ timezone: 'Asia/Singapore' }),
    ...confirmations.store,
    unreadBookmarks: async () => [],
    cards: async () => myCards.map(c => ({ ...c })),
    updateCard: async (_u, id, revision, patch, now) => {
      const c = myCards.find(x => x.id === id);
      if (!c) return 'missing';
      if (c.revision !== revision) return 'conflict';
      Object.assign(c, patch, { updatedAt: now, revision: revision + 1 });
      return 'ok';
    },
    deleteCard: async (_u, id, revision) => {
      const i = myCards.findIndex(x => x.id === id);
      if (i < 0) return 'missing';
      if (myCards[i].revision !== revision) return 'conflict';
      myCards.splice(i, 1);
      return 'ok';
    },
  };
  let clock = 1_800_000_000_000;
  const sent: string[] = [], pages: string[] = [], edits: string[] = [], buttons: unknown[] = [], toasts: string[] = [], ollamaUrls: string[] = [];
  let offsets: number[] = [];
  let pendingUpdates: Update[] = [];
  const relayCalls: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://script.google.com/macros/s/')) {
      // Simplified v2 transport; crash/lease behavior is covered by the Apps Script simulator.
      const params = new URL(url).searchParams;
      expect(params.get('key')).toBe('k'.repeat(40));
      relayCalls.push(`${params.get('action')}:${params.get('who')}`);
      if (params.get('action') !== 'claim') return new Response(JSON.stringify({ protocol: 2, ok: true }));
      const update = pendingUpdates.shift();
      return new Response(JSON.stringify({ protocol: 2, deliveries: update ? [{ id: String(update.update_id), token: 'a'.repeat(32), until: clock + 120000, update }] : [] }));
    }
    if (url.startsWith(`https://api.telegram.org/bot${TOKEN}/sendMessage`)) {
      const body = JSON.parse(String(init?.body));
      expect(body.chat_id).toBe(CHAT);
      sent.push(body.text);
      if (body.reply_markup) buttons.push(body.reply_markup.inline_keyboard);
      return new Response('{"ok":true}');
    }
    if (url.includes('/editMessageText')) { edits.push(JSON.parse(String(init?.body)).text); return new Response('{"ok":true}'); }
    if (url.includes('/answerCallbackQuery')) { const text = JSON.parse(String(init?.body)).text; if (text) toasts.push(text); return new Response('{"ok":true}'); }
    if (url.includes('/sendChatAction')) return new Response('{"ok":true}');
    if (url.includes('/api/chat')) {
      ollamaUrls.push(url);
      if (!ollama) return new Response('', { status: 500 });
      return new Response(JSON.stringify((() => { const r = ollama(JSON.parse(String(init?.body))) as any; return { done: true, done_reason: 'stop', ...r, message: { role: 'assistant', ...r.message } }; })()));
    }
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
  let updateId = 10;
  const message = (text: string, chat = Number(CHAT), age = 0): Update => ({ update_id: ++updateId, message: { date: Math.floor(clock / 1000) - age, text, chat: { id: chat } } });
  const tap = (data: string, chat = Number(CHAT)): Update => ({ update_id: 2, callback_query: { id: 'cb', data, message: { message_id: 77, chat: { id: chat } } } });
  const lastButtons = () => buttons.at(-1) as { text: string; callback_data: string }[][];
  return { deps, handle, message, tap, sent, edits, pages, states, cards, bookmarks, parcels, relayCalls, lastButtons, inbox: () => confirmations.state().pending, myCards, toasts, ollamaUrls, confirmations,
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
    expect(s.sent[0]).toBe('Doot Doot.\n• <b>EX13 singles</b>, from your PC: checked 2 min ago, 12 items; changed 2 h ago (12 new)\n• <b>News</b> (paused), from GitHub: not checked yet\nLocal AI: qwen3:14b at http://localhost:11434');
  });

  it('answers /help and unknown messages', async () => {
    const s = setup([]);
    await s.handle(s.message('/help'));
    await s.handle(s.message('what?'));
    expect(s.sent[0]).toContain('/check: check your PC watches now');
    expect(s.sent[1]).toContain("I couldn't reach the AI on your PC"); // free text is a question now
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
    expect(s.edits.at(-1)).toContain('Saved to My Space');
  });

  it('cancels, saves notes and reading-list links, and ignores other chats', async () => {
    const s = setup([]);
    await s.handle(s.message('note: book the venue\nfor 40 people'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nSave this note to My Space?\n<b>Book the venue</b>\nfor 40 people');
    await s.handle(s.tap(s.lastButtons()[0][1].callback_data));
    expect(s.edits.at(-1)).toContain('OK, I left it as it is.');
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
    expect(s.sent.at(-1)).toContain("I couldn't reach the AI on your PC");
  });

  it('retries a failed Telegram result notification without repeating the saved effect', async () => {
    const s = setup([]);
    await s.handle(s.message('note: a synthetic retry'));
    const save = s.lastButtons()[0][0].callback_data;
    const fetcher = s.deps.fetcher!;
    let fail = true;
    s.deps.fetcher = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/editMessageText') && fail) { fail = false; throw new Error('Synthetic network loss'); }
      return fetcher(input, init);
    }) as typeof fetch;
    await expect(s.handle(s.tap(save))).rejects.toThrow();
    expect(s.cards).toHaveLength(1);
    await s.handle(s.tap(save));
    expect(s.cards).toHaveLength(1);
    expect(s.edits.at(-1)).toContain('Saved to My Space');
  });

  it('rejects unknown callback actions and legacy unbound buttons without a write', async () => {
    const s = setup([]);
    await s.handle(s.message('note: a synthetic confirmation'));
    const save = s.lastButtons()[0][0].callback_data;
    await s.handle(s.tap(save.replace('save:', 'anything:')));
    await s.handle(s.tap(save.split(':').slice(0, 2).join(':')));
    expect(s.cards).toHaveLength(0);
    expect(s.edits.at(-1)).toContain('no longer valid');
    await s.handle(s.tap(save));
    expect(s.cards).toHaveLength(1);
  });

  it('in the cloud, answers messages, reports /check from this run, and acknowledges what it handled', async () => {
    const s = setup([watch(), watch({ id: 'w2', label: 'Card shop', url: 'https://cards.example/', runOn: 'auto' })],
      { w2: { checkedAt: 1_800_000_000_000 - 20_000, status: 'ok', itemCount: 12 } as WatchState });
    const now = Math.floor(1_800_000_000_000 / 1000);
    s.queue([
      { update_id: 41, message: { date: now, text: '/check', chat: { id: Number(CHAT) } } },
      { update_id: 42, message: { date: now, text: 'remind me to water plants today', chat: { id: Number(CHAT) } } },
    ]);
    await drainOnce(s.deps);
    expect(s.pages).toEqual([]); // nothing is fetched again: the run just checked GitHub's watches
    expect(s.sent[0]).toContain('GitHub just checked these:\n• <b>Card shop</b>, from GitHub: checked');
    expect(s.sent[0]).toContain('12 items');
    expect(s.sent[0]).toContain("Your PC is off or asleep, so <b>EX13 singles</b> waits until it's back.");
    expect(s.sent[1]).toContain('<b>Water plants</b>\nDue: today');
    expect(s.offsets()).toEqual([0, 43]); // the second call confirms both updates
  });
});

describe('the Telegram relay', () => {
  it('in the cloud, collects from the relay instead of Telegram, until it is empty', async () => {
    const s = setup([]);
    s.deps.relay = { url: 'https://script.google.com/macros/s/abc_DEF-123/exec', key: 'k'.repeat(40) };
    const now = Math.floor(1_800_000_000_000 / 1000);
    s.queue([
      { update_id: 41, message: { date: now, text: 'remind me to water plants today', chat: { id: Number(CHAT) } } },
      { update_id: 42, message: { date: now, text: 'note: buy stamps', chat: { id: Number(CHAT) } } },
    ]);
    await drainOnce(s.deps);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[0]).toContain('<b>Water plants</b>');
    expect(s.sent[1]).toContain('<b>Buy stamps</b>');
    expect(s.offsets()).toEqual([]); // never getUpdates while the relay is in use
    expect(s.relayCalls).toEqual(['claim:cloud', 'ack:cloud', 'claim:cloud', 'ack:cloud', 'claim:cloud']); // a second look finds nothing more
  });

  it('on the PC, takes and handles one batch at a time', async () => {
    const s = setup([]);
    s.deps.relay = { url: 'https://script.google.com/macros/s/abc_DEF-123/exec', key: 'k'.repeat(40) };
    s.queue([{ update_id: 7, message: { date: Math.floor(1_800_000_000_000 / 1000), text: '/help', chat: { id: Number(CHAT) } } }]);
    expect(await relayRound(s.deps, 'pc', s.handle)).toBe(1);
    expect(s.sent.at(-1)).toContain('/check');
    expect(await relayRound(s.deps, 'pc', s.handle)).toBe(0);
    expect(s.relayCalls).toEqual(['claim:pc', 'ack:pc', 'claim:pc']);
  });
});

describe('editing existing cards', () => {
  it('/done asks first, then completes with the revision it saw', async () => {
    const s = setup([], {}, [card({})]);
    await s.handle(s.message('/done brief'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nMark this done?\n<b>File the brief</b>');
    const [[yes, no]] = s.lastButtons();
    expect([yes.text, no.text]).toEqual(['Mark done', 'Cancel']);
    expect(s.myCards[0].done).toBe(false);
    await s.handle(s.tap(yes.callback_data));
    expect(s.myCards[0]).toMatchObject({ done: true, revision: 4 });
    expect(s.edits.at(-1)).toContain('Done ✓ <b>File the brief</b> (moved to Archive)');
  });

  it('offers a choice when several cards match, and applies only the chosen one', async () => {
    const s = setup([], {}, [card({ id: 'a', title: 'Pay rent' }), card({ id: 'b', title: 'Pay phone bill' }), card({ id: 'c', title: 'Pay tuition' })]);
    await s.handle(s.message('/done pay'));
    const rows = s.lastButtons();
    expect(rows.map(r => r[0].text)).toEqual(['✓ Pay rent', '✓ Pay phone bill', '✓ Pay tuition', 'Cancel']);
    expect(rows.every(r => r[0].callback_data.length <= 64)).toBe(true);
    await s.handle(s.tap(rows[1][0].callback_data));
    expect(s.myCards.filter(c => c.done).map(c => c.id)).toEqual(['b']);
    // The other offers in that message are gone.
    await s.handle(s.tap(rows[0][0].callback_data));
    expect(s.myCards.filter(c => c.done).map(c => c.id)).toEqual(['b']);
  });

  it('never overwrites a newer edit made elsewhere', async () => {
    const s = setup([], {}, [card({})]);
    await s.handle(s.message('/move brief to Monday'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nMove this to Mon 18 Jan?\n<b>File the brief</b>');
    s.myCards[0].revision = 9; // edited on another device meanwhile
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.myCards[0].dueDate).toBe('2027-01-15');
    expect(s.edits.at(-1)).toContain('was changed somewhere else since I asked');
  });

  it('/move and /delete apply after confirmation; unclear requests explain', async () => {
    const s = setup([], {}, [card({}), card({ id: 'n', kind: 'note', title: 'Old idea', dueDate: '' })]);
    await s.handle(s.message('/move the brief to 20/1'));
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.myCards[0]).toMatchObject({ dueDate: '2027-01-20', revision: 4 });
    expect(s.edits.at(-1)).toContain('Updated ✓ <b>File the brief</b>, due Wed 20 Jan');
    await s.handle(s.message('/delete old idea'));
    expect(s.sent.at(-1)).toContain('Delete this?');
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.myCards.map(c => c.id)).toEqual(['c1']);
    await s.handle(s.message('/done nothing like this'));
    expect(s.sent.at(-1)).toContain('No open reminder matches');
    await s.handle(s.message('/move the brief'));
    expect(s.sent.at(-1)).toContain('Which day?');
  });

  it('one-tap ✓ buttons complete straight away, still revision-checked', async () => {
    const s = setup([], {}, [card({})]);
    await s.handle(s.tap('done:c1:2')); // stale revision
    expect(s.myCards[0].done).toBe(false);
    expect(s.toasts.at(-1)).toContain('changed elsewhere');
    await s.handle(s.tap('done:c1:3'));
    expect(s.myCards[0].done).toBe(true);
    expect(s.toasts.at(-1)).toBe('✓ File the brief is done');
    await s.handle(s.tap('done:c1:3', 999)); // strangers are ignored
    expect(s.toasts).toHaveLength(2);
  });
});

describe('questions', () => {
  it('answers from tools on the local model and offers changes as buttons', async () => {
    const calls: any[] = [];
    const s = setup([], {}, [card({}), card({ id: 'x', title: 'Exam', dueDate: '2027-01-20' })], body => {
      calls.push(body);
      if (calls.length === 1) return { message: { content: '', tool_calls: [{ function: { name: 'list_reminders', arguments: { when: 'this_week' } } }] } };
      if (calls.length === 2) return { message: { content: '', tool_calls: [{ function: { name: 'propose_complete', arguments: { id: 'c1' } } }] } };
      return { message: { content: 'Before your **Exam** on 20 Jan: <File the brief> is due today.' } };
    });
    await s.handle(s.message("what's due before my exam? also mark the brief done"));
    // The model only ever runs on this machine, whatever the saved setting says.
    expect(new Set(s.ollamaUrls)).toEqual(new Set(['http://localhost:11434/api/chat']));
    expect(calls[0].model).toBe('qwen3:14b');
    expect(calls[0].messages[0].content).toContain('Today is Friday 2027-01-15 (Asia/Singapore)');
    const toolResult = JSON.parse(calls[1].messages.at(-1).content);
    expect(toolResult.map((r: any) => r.title)).toEqual(['File the brief', 'Exam']);
    expect(s.sent.find(t => t.includes('Before your'))).toBe('Doot Doot.\nBefore your <b>Exam</b> on 20 Jan: &lt;File the brief&gt; is due today.\n\nTap below to confirm.');
    expect(s.sent.at(-1)).toBe('Doot Doot.\nMark this done?\n<b>File the brief</b>');
    expect(s.myCards[0].done).toBe(false); // nothing changes until the owner taps
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.myCards[0].done).toBe(true);
  });

  it('rejects made-up ids, and explains when the model is unreachable or the PC is off', async () => {
    const s = setup([], {}, [card({})], body => body.messages.length < 3
      ? { message: { tool_calls: [{ function: { name: 'propose_delete', arguments: '{"id":"invented"}' } }] } }
      : { message: { content: 'I could not find that card.' } });
    await s.handle(s.message('delete my tax note'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nI could not find that card.');
    expect(s.inbox()).toEqual({});
    const down = setup([], {}, []);
    await down.handle(down.message('what is on tomorrow'));
    expect(down.sent.at(-1)).toContain("I couldn't reach the AI on your PC");
    const cloud = setup([], {}, []);
    cloud.deps.mode = 'cloud';
    await makeHandler(cloud.deps, makeQueue())(cloud.message('what is on tomorrow'));
    expect(cloud.sent.at(-1)).toContain('the AI on your PC, which is off or asleep');
    expect(cloud.ollamaUrls).toEqual([]);
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

describe('tracking parcels from Telegram', () => {
  it('replies that parcel tracking is archived, and still treats "track my …" as a question', async () => {
    const s = setup([]); // archived by default (PARCELS_ENABLED = false)
    await s.handle(s.message('track SPXSG012345678901 keyboard'));
    expect(s.sent.at(-1)).toBe("Doot Doot.\nParcel tracking is archived, so I'm not tracking parcels right now.");
    await s.handle(s.message('/parcels'));
    expect(s.sent.at(-1)).toContain('Parcel tracking is archived');
    expect(s.parcels).toEqual([]);
    await s.handle(s.message('track my budget this month'));
    expect(s.sent.at(-1)).toContain("I couldn't reach the AI on your PC");
  });

  it('proposes a parcel from "track …", saves it as Voracity would, and refuses a repeat', async () => {
    const s = setup([]);
    s.deps.parcelsEnabled = true;
    await s.handle(s.message('track spxsg012345678901 keyboard from lazada'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\nTrack this parcel?\n<b>Keyboard from lazada</b>\n<code>SPXSG012345678901</code>');
    expect(s.parcels).toEqual([]);
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.parcels).toHaveLength(1);
    expect(s.parcels[0]).toMatchObject({ number: 'SPXSG012345678901', label: 'Keyboard from lazada', carrier: 0, archived: false, revision: 0 });
    expect(Object.keys(s.parcels[0]).sort()).toEqual(['archived', 'carrier', 'createdAt', 'id', 'label', 'number', 'revision', 'updatedAt']);
    expect(s.edits.at(-1)).toContain("Tracking ✓\n<b>Keyboard from lazada</b>. I'll message you when it moves.");

    await s.handle(s.message('/track SPXSG012345678901'));
    expect(s.sent.at(-1)).toContain('<b>Parcel ending 8901</b>');
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    expect(s.parcels).toHaveLength(1);
    expect(s.edits.at(-1)).toContain("You're already tracking <code>SPXSG012345678901</code>");
  });

  it('keeps "track my …" as a question, explains a bare /track, and lists parcels', async () => {
    const s = setup([]);
    s.deps.parcelsEnabled = true;
    await s.handle(s.message('/track'));
    expect(s.sent.at(-1)).toContain('Send /track with the tracking number');
    await s.handle(s.message('track my budget this month'));
    expect(s.sent.at(-1)).toContain("I couldn't reach the AI on your PC"); // treated as a question
    await s.handle(s.message('track EB123456789SG textbooks'));
    await s.handle(s.tap(s.lastButtons()[0][0].callback_data));
    s.parcels[0].id = 'p0';
    await s.handle(s.message('/parcels'));
    expect(s.sent.at(-1)).toBe('Doot Doot.\n• <b>Textbooks</b>: Out for delivery');
    expect(parseCommand('/parcels')).toEqual({ name: 'parcels' });
  });
});

describe('capture delivery recovery', () => {
  it('replays the original buttons after a lost notification, even after confirmation', async () => {
    const s = setup([]), original = s.message('note: Synthetic capture');
    const normal = s.deps.fetcher!;
    let failSend = true;
    s.deps.fetcher = (async (input, init) => {
      if (String(input).includes('/sendMessage') && failSend) { failSend = false; throw new Error('lost send'); }
      return normal(input, init);
    }) as typeof fetch;
    await expect(s.handle(original)).rejects.toThrow();
    const ids = Object.keys(s.inbox()); expect(ids).toHaveLength(1);
    await s.handle(original);
    const button = s.lastButtons()[0][0].callback_data;
    await s.handle(s.tap(button));
    expect(s.cards).toHaveLength(1);
    await makeHandler(s.deps, makeQueue())(original); // Simulate a fresh process.
    expect(s.lastButtons()[0][0].callback_data).toBe(button);
    await s.handle(s.tap(button));
    expect(s.cards).toHaveLength(1); expect(s.inbox()).toEqual({});
  });
  it('recovers the original model answer and proposal without invoking the model again', async () => {
    let calls = 0;
    const s = setup([], {}, [card({})], () => ++calls === 1
      ? { message: { tool_calls: [{ function: { name: 'propose_complete', arguments: { id: 'c1' } } }] } }
      : { message: { content: 'Synthetic answer' } });
    const original = s.message('mark the brief done');
    await s.handle(original);
    const firstCalls = calls, firstButtons = s.lastButtons();
    await s.handle(original);
    expect(calls).toBe(firstCalls); expect(s.lastButtons()).toEqual(firstButtons);
    expect(s.sent.filter(t => t.includes('Synthetic answer'))).toHaveLength(2);
  });
  it('retains direct-poll offsets on failure without skipping later messages', async () => {
    const s = setup([]); s.queue([{ update_id: 1 }, { update_id: 2 }, { update_id: 3 }]);
    const seen: number[] = [];
    await expect(pollOnce(s.deps, 0, async u => { seen.push(u.update_id); if (u.update_id === 2) throw new Error('failed'); })).rejects.toMatchObject({ nextOffset: 2 });
    expect(seen).toEqual([1, 2]);
  });
});
