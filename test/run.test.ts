import { describe, expect, it } from 'vitest';
import type { Translate } from '../src/translate.ts';
import { USER_AGENT } from '../src/fetch.ts';
import { backoff, hostLimits, isDue, runOnce, type ItemsDoc, type Store, type Watch, type WatchState } from '../src/run.ts';

const UID = 'ownerUid123';
const CHAT = '424242';
const watch = (over: Partial<Watch> = {}): Watch => ({ id: 'w1', label: 'EX13', url: 'https://shop.example/sell/ex13', selector: '.item', ignore: '', interval: 5, enabled: true, createdAt: 1, ...over });
const html = (...items: string[]) => `<html><body>${items.map(item => `<div class="item">${item}</div>`).join('')}</body></html>`;

function memoryStore(watches: Watch[]) {
  const states = new Map<string, WatchState>(), items = new Map<string, ItemsDoc>();
  let heartbeat = 0;
  const heartbeats: string[] = [];
  let itemWrites = 0;
  const store: Store = {
    watches: async () => watches,
    states: async () => new Map(states),
    items: async () => new Map(items),
    save: async (_uid, id, state, doc) => { states.set(id, state); if (doc) { items.set(id, doc); itemWrites++; } },
    removeItems: async (_uid, id) => { items.delete(id); },
    heartbeat: async (_uid, at, runner) => { heartbeat = at; heartbeats.push(runner); },
  };
  return { store, states, items, heartbeatAt: () => heartbeat, heartbeats, itemWrites: () => itemWrites };
}

/** A fake network and clock. Records requests with their (fake) time. */
function world(routes: Record<string, () => Response>) {
  let clock = 1_000_000_000_000;
  const requests: { url: string; at: number; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, at: clock, headers: init?.headers as Record<string, string> });
    const route = routes[url];
    if (!route) throw new TypeError('fetch failed');
    return route();
  }) as typeof fetch;
  return {
    fetcher, requests, now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    advance: (ms: number) => { clock += ms; },
  };
}

const ok = (body: string, headers: Record<string, string> = {}) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const robots = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });

async function run(env: ReturnType<typeof world>, store: Store, extra: { test?: boolean; runner?: 'cloud' | 'local'; translate?: Translate } = {}) {
  const sent: string[] = [], logs: string[] = [];
  const totals = await runOnce({ owners: { [UID]: CHAT }, store, fetcher: env.fetcher, now: env.now, sleep: env.sleep, log: line => logs.push(line), send: async (chat, text) => { expect(chat).toBe(CHAT); sent.push(text); }, ...extra });
  return { sent, logs, totals };
}

describe('scheduling', () => {
  it('honours intervals with a small grace period, pauses, and retry times', () => {
    const now = 10_000_000;
    expect(isDue(watch(), undefined, now)).toBe(true);
    expect(isDue(watch(), { status: 'ok', checkedAt: now - 4 * 60_000 }, now)).toBe(true);
    expect(isDue(watch(), { status: 'ok', checkedAt: now - 3 * 60_000 }, now)).toBe(false);
    expect(isDue(watch({ enabled: false }), undefined, now)).toBe(false);
    expect(isDue(watch(), { status: 'error', checkedAt: 0, retryAt: now + 1 }, now)).toBe(false);
    expect(backoff(watch(), 1)).toBe(5 * 60_000);
    expect(backoff(watch(), 4)).toBe(40 * 60_000);
    expect(backoff(watch({ interval: 1440 }), 3)).toBe(86_400_000);
    expect(backoff(watch(), 1, 3_600_000)).toBe(3_600_000);
    expect(hostLimits({ rules: [] })).toEqual({ spacing: 3000, perRun: 5 });
    expect(hostLimits({ rules: [], crawlDelay: 60 })).toEqual({ spacing: 60_000, perRun: 2 });
  });
});

describe('a watcher run', () => {
  it('records a baseline, then reports changes only when items differ', async () => {
    const memory = memoryStore([watch()]);
    let body = html('EX13-001 Agumon 980 円');
    const env = world({ 'https://shop.example/robots.txt': robots('User-agent: *\nDisallow: /cart'), 'https://shop.example/sell/ex13': () => ok(body)() });
    const first = await run(env, memory.store);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]).toMatch(/^Doot Doot\.\nNow watching <b>EX13<\/b>: 1 item matches/);
    expect(memory.states.get('w1')).toMatchObject({ status: 'ok', itemCount: 1, failures: 0 });
    expect(memory.heartbeatAt()).toBe(env.now());
    expect(env.requests[0].headers['User-Agent']).toBe(USER_AGENT);

    env.advance(5 * 60_000);
    expect((await run(env, memory.store)).sent).toEqual([]);
    expect(memory.itemWrites()).toBe(1); // unchanged page: state updated, snapshot not rewritten

    env.advance(5 * 60_000);
    body = html('EX13-001 Agumon 880 円', 'EX13-002 Gabumon 1,200 円');
    const third = await run(env, memory.store);
    expect(third.sent).toHaveLength(1);
    expect(third.sent[0]).toContain('<b>EX13</b>: 1 new, 1 price drop.');
    expect(third.sent[0]).toContain('<b>💸 Price down</b>\n• Agumon: ¥980 → <b>¥880</b>');
    expect(third.sent[0]).toContain('• EX13-001 Agumon: ¥980 → ¥880');
    expect(memory.states.get('w1')).toMatchObject({ summary: '1 new, 1 price drop', changedAt: env.now(), itemCount: 2 });
  });

  it('translates Japanese names once on the PC, caches them, and still alerts without the model', async () => {
    const memory = memoryStore([watch({ runOn: 'local' })]); // a watch on the PC, like yuyu-tei
    let body = html('EX13-060 アルファモン(パラレル) 2,480 円 在庫 : 1 点', 'EX13-014 ジエスモン(パラレル) 1,980 円 在庫 : 3 点');
    const env = world({ 'https://shop.example/robots.txt': robots('User-agent: *'), 'https://shop.example/sell/ex13': () => ok(body)() });
    const asked: string[][] = [];
    const translate: Translate = async (_uid, names) => { asked.push(names); return Object.fromEntries(names.map(n => [n, n.startsWith('アルファ') ? 'Alphamon (Parallel)' : 'Jesmon (Parallel)'])); };
    await run(env, memory.store, { runner: 'local', translate }); // baseline: nothing translated yet
    expect(asked).toEqual([]);

    env.advance(5 * 60_000);
    body = html('EX13-060 アルファモン(パラレル) 2,480 円 在庫 : ×', 'EX13-014 ジエスモン(パラレル) 1,980 円 在庫 : 3 点');
    const sold = await run(env, memory.store, { runner: 'local', translate });
    expect(asked).toEqual([['アルファモン(パラレル)']]); // only names the alert shows
    expect(sold.sent[0]).toContain('<b>🔴 Sold out</b>\n• Alphamon (Parallel) · ¥2,480');
    expect(memory.items.get('w1')!.names).toEqual({ 'アルファモン(パラレル)': 'Alphamon (Parallel)' });
    expect(memory.states.get('w1')!.summary).toBe('1 sold out');

    env.advance(5 * 60_000);
    body = html('EX13-060 アルファモン(パラレル) 2,480 円 在庫 : 2 点', 'EX13-014 ジエスモン(パラレル) 1,980 円 在庫 : 2 点');
    await run(env, memory.store, { runner: 'local', translate });
    expect(asked.at(-1)).toEqual(['ジエスモン(パラレル)']); // Alphamon came from the cache

    env.advance(5 * 60_000);
    body = html('EX13-060 アルファモン(パラレル) 2,480 円 在庫 : 1 点', 'EX13-014 ジエスモン(パラレル) 1,980 円 在庫 : 2 点', 'EX13-070 オメガモンX 3,980 円 在庫 : 1 点');
    const offline = await run(env, memory.store, { runner: 'local', translate: async () => { throw new Error('Ollama is off'); } });
    expect(offline.sent[0]).toContain('<b>✨ New</b>\n• オメガモンX · ¥3,980 · 1 left');
    expect(offline.logs).toContain('translation unavailable; sending original names');
    expect(memory.items.get('w1')!.names).toMatchObject({ 'アルファモン(パラレル)': 'Alphamon (Parallel)', 'ジエスモン(パラレル)': 'Jesmon (Parallel)' });
  });

  it('never fetches pages robots.txt disallows, and says so once', async () => {
    const memory = memoryStore([watch()]);
    const env = world({ 'https://shop.example/robots.txt': robots('User-agent: *\nDisallow: /sell') });
    const { sent } = await run(env, memory.store);
    expect(env.requests.map(r => r.url)).toEqual(['https://shop.example/robots.txt']);
    expect(sent[0]).toContain("robots.txt does not allow automated checks");
    expect(memory.states.get('w1')).toMatchObject({ status: 'error', failures: 1, retryAt: env.now() + 86_400_000 });
  });

  it('pauses everything when robots.txt fails with a server error', async () => {
    const memory = memoryStore([watch()]);
    const env = world({ 'https://shop.example/robots.txt': () => new Response('', { status: 503 }), 'https://shop.example/sell/ex13': ok(html('a')) });
    await run(env, memory.store);
    expect(env.requests.map(r => r.url)).toEqual(['https://shop.example/robots.txt']);
    expect(memory.states.get('w1')?.error).toContain('temporarily unavailable');
  });

  it('spaces requests to one host by its Crawl-delay and caps checks per run', async () => {
    const watches = Array.from({ length: 4 }, (_, i) => watch({ id: 'w' + i, url: `https://shop.example/sell/${i}` }));
    const routes: Record<string, () => Response> = { 'https://shop.example/robots.txt': robots('User-agent: *\nCrawl-delay: 50') };
    watches.forEach(w => { routes[w.url] = ok(html('x')); });
    const env = world(routes), memory = memoryStore(watches);
    const { totals } = await run(env, memory.store);
    const times = env.requests.map(r => r.at);
    expect(env.requests).toHaveLength(3); // robots + floor(120 / 50) = 2 pages
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(50_000);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(50_000);
    expect(totals.postponed).toBe(2);
  });

  it('backs off on 429 using Retry-After, alerting only after repeated failures', async () => {
    const memory = memoryStore([watch()]);
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }) });
    const first = await run(env, memory.store);
    expect(first.sent).toEqual([]);
    expect(memory.states.get('w1')).toMatchObject({ status: 'error', failures: 1, retryAt: env.now() + 3_600_000 });
    env.advance(30 * 60_000);
    await run(env, memory.store);
    expect(env.requests.filter(r => r.url.endsWith('ex13'))).toHaveLength(1); // still waiting
  });

  it('moves a watch to the local runner after two cloud refusals, and the cloud never contacts it again', async () => {
    const memory = memoryStore([watch()]);
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': () => new Response('', { status: 403 }) });
    const page = () => env.requests.filter(r => r.url.endsWith('ex13')).length;
    const first = await run(env, memory.store);
    expect(first.sent).toEqual([]);
    expect(memory.states.get('w1')).toMatchObject({ status: 'error', cloudRefusals: 1 });
    expect(memory.states.get('w1')?.route).toBeUndefined();
    env.advance(5 * 60_000);
    const second = await run(env, memory.store);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]).toMatch(/^Doot Doot\.\n<b>EX13<\/b> refuses GitHub's servers \(HTTP 403\), so your PC checks it from now on/);
    expect(memory.states.get('w1')).toMatchObject({ route: 'local', cloudRefusals: 0, movedAt: env.now() });
    expect(second.logs.at(-1)).toContain('moved 1');
    // Weeks of cloud runs: no request to the site, no message.
    for (let day = 0; day < 30; day++) {
      env.advance(86_400_000);
      expect((await run(env, memory.store)).sent).toEqual([]);
    }
    expect(page()).toBe(2);
    expect(memory.heartbeats.every(runner => runner === 'cloud')).toBe(true);
    // The PC checks it on its very next run, without waiting out the interval.
    const local = await run(env, memory.store, { runner: 'local' });
    expect(local.logs.at(-1)).toContain('checked 1');
    expect(page()).toBe(3);
  });

  it('the local runner checks only moved watches, alerts on its own refusals and announces recovery once', async () => {
    const watches = [watch(), watch({ id: 'w2', url: 'https://other.example/news' })];
    const memory = memoryStore(watches);
    memory.states.set('w1', { status: 'error', checkedAt: 0, failures: 0, alerted: false, route: 'local', movedAt: 0 }); // as written by the hand-off
    let status = 403;
    const env = world({
      'https://shop.example/robots.txt': robots(''), 'https://other.example/robots.txt': robots(''),
      'https://shop.example/sell/ex13': () => status === 200 ? ok(html('a'))() : new Response('', { status }),
      'https://other.example/news': ok(html('n')),
    });
    await run(env, memory.store, { runner: 'local' });
    expect(env.requests.map(r => r.url)).not.toContain('https://other.example/news');
    expect(memory.states.get('w1')).toMatchObject({ route: 'local', failures: 1 });
    env.advance(memory.states.get('w1')!.retryAt! - env.now());
    const second = await run(env, memory.store, { runner: 'local' });
    expect(second.sent.join()).toContain('refused access (HTTP 403)');
    expect(memory.states.get('w1')?.route).toBe('local');
    status = 200;
    env.advance(memory.states.get('w1')!.retryAt! - env.now());
    const third = await run(env, memory.store, { runner: 'local' });
    expect(third.sent.filter(text => text.includes('reachable again'))).toHaveLength(1);
    expect(memory.states.get('w1')).toMatchObject({ status: 'ok', alerted: false, route: 'local' });
    expect(memory.heartbeats).toEqual(['local', 'local', 'local']);
    // The cloud runner handles only the other watch.
    env.requests.length = 0;
    await run(env, memory.store);
    expect(env.requests.map(r => r.url)).toEqual(['https://other.example/robots.txt', 'https://other.example/news']);
    expect((await run(env, memory.store, { runner: 'local', test: true })).sent[0]).toBe('Doot Doot.\nIca is connected to Voracity from your PC. 2 sites are being watched.');
  });

  it('adopts watches the cloud runner refused before hand-offs existed, without another cloud request', async () => {
    const memory = memoryStore([watch()]);
    // As left by the old cloud runner: an hour-long backoff from a daily-ish interval.
    memory.states.set('w1', { status: 'error', checkedAt: 999_999_000_000, error: 'the site refused access (HTTP 403)', failures: 1, retryAt: 1_000_000_000_000 + 3_600_000 });
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': ok(html('a')) });
    await run(env, memory.store);
    expect(env.requests).toEqual([]); // the cloud leaves it alone
    const local = await run(env, memory.store, { runner: 'local' });
    expect(local.sent[0]).toContain('Now watching');
    expect(memory.states.get('w1')).toMatchObject({ status: 'ok', route: 'local' });
    env.advance(5 * 60_000);
    env.requests.length = 0;
    await run(env, memory.store);
    expect(env.requests).toEqual([]); // still the PC's, even after a successful check
  });

  it("watches set to 'Only my PC' are never fetched by the cloud runner", async () => {
    const memory = memoryStore([watch({ runOn: 'local' })]);
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': ok(html('a')) });
    await run(env, memory.store);
    expect(env.requests).toEqual([]);
    const local = await run(env, memory.store, { runner: 'local' });
    expect(local.sent[0]).toContain('Now watching');
    expect(env.requests.map(r => r.url)).toEqual(['https://shop.example/robots.txt', 'https://shop.example/sell/ex13']);
  });

  it('a successful cloud check clears an earlier single refusal', async () => {
    const memory = memoryStore([watch()]);
    let status = 403;
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': () => status === 200 ? ok(html('a'))() : new Response('', { status }) });
    await run(env, memory.store);
    status = 200; env.advance(5 * 60_000);
    await run(env, memory.store);
    expect(memory.states.get('w1')).toMatchObject({ status: 'ok', cloudRefusals: 0 });
    status = 403; env.advance(5 * 60_000);
    await run(env, memory.store);
    expect(memory.states.get('w1')).toMatchObject({ cloudRefusals: 1 });
    expect(memory.states.get('w1')?.route).toBeUndefined();
  });

  it('keeps the old snapshot when Telegram fails, so the change is reported next time', async () => {
    const memory = memoryStore([watch()]);
    let body = html('A1 one');
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': () => ok(body)() });
    await run(env, memory.store);
    body = html('A1 one', 'B2 two');
    env.advance(5 * 60_000);
    await runOnce({ owners: { [UID]: CHAT }, store: memory.store, fetcher: env.fetcher, now: env.now, sleep: env.sleep, send: async () => { throw new Error('down'); } });
    expect(memory.items.get('w1')?.items).toEqual(['A1 one']);
    env.advance(5 * 60_000);
    expect((await run(env, memory.store)).sent[0]).toContain('1 new');
  });

  it('re-baselines when the selector changes and sends conditional requests otherwise', async () => {
    const memory = memoryStore([watch()]);
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': ok(html('a'), { etag: '"v1"' }) });
    await run(env, memory.store);
    env.advance(5 * 60_000);
    await run(env, memory.store);
    expect(env.requests.at(-1)?.headers['If-None-Match']).toBe('"v1"');
    const changed = memoryStore([watch({ selector: 'body' })]);
    memory.items.forEach((doc, id) => changed.items.set(id, doc));
    env.advance(5 * 60_000);
    const { sent } = await run(env, changed.store);
    expect(sent[0]).toContain('Now watching');
    expect(env.requests.at(-1)?.headers['If-None-Match']).toBeUndefined();
  });

  it('logs only counts: no addresses, owner IDs or chat IDs', async () => {
    const memory = memoryStore([watch()]);
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': ok(html('Secret item')) });
    const { logs } = await run(env, memory.store, { test: true });
    const text = logs.join('\n');
    for (const secret of ['shop.example', UID, CHAT, 'Secret', 'EX13']) expect(text).not.toContain(secret);
    expect(text).toMatch(/checked 1/);
  });

  it('sends a Doot Doot. connection test on request and removes snapshots of deleted watches', async () => {
    const memory = memoryStore([]);
    memory.items.set('gone', { items: [], url: '', selector: '', ignore: '' });
    const { sent } = await run(world({}), memory.store, { test: true });
    expect(sent).toEqual(['Doot Doot.\nIca is connected to Voracity. 0 sites are being watched.']);
    expect(memory.items.has('gone')).toBe(false);
  });
});
