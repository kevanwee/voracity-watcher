import { describe, expect, it } from 'vitest';
import { USER_AGENT } from '../src/fetch.ts';
import { backoff, hostLimits, isDue, runOnce, type ItemsDoc, type Store, type Watch, type WatchState } from '../src/run.ts';

const UID = 'ownerUid123';
const CHAT = '424242';
const watch = (over: Partial<Watch> = {}): Watch => ({ id: 'w1', label: 'EX13', url: 'https://shop.example/sell/ex13', selector: '.item', ignore: '', interval: 5, enabled: true, createdAt: 1, ...over });
const html = (...items: string[]) => `<html><body>${items.map(item => `<div class="item">${item}</div>`).join('')}</body></html>`;

function memoryStore(watches: Watch[]) {
  const states = new Map<string, WatchState>(), items = new Map<string, ItemsDoc>();
  let heartbeat = 0;
  let itemWrites = 0;
  const store: Store = {
    watches: async () => watches,
    states: async () => new Map(states),
    items: async () => new Map(items),
    save: async (_uid, id, state, doc) => { states.set(id, state); if (doc) { items.set(id, doc); itemWrites++; } },
    removeItems: async (_uid, id) => { items.delete(id); },
    heartbeat: async (_uid, at) => { heartbeat = at; },
  };
  return { store, states, items, heartbeatAt: () => heartbeat, itemWrites: () => itemWrites };
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

async function run(env: ReturnType<typeof world>, store: Store, extra: { test?: boolean } = {}) {
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
    expect(third.sent[0]).toContain('1 new, 1 changed');
    expect(third.sent[0]).toContain('<i>was: EX13-001 Agumon 980 円</i>');
    expect(memory.states.get('w1')).toMatchObject({ summary: '1 new, 1 changed', changedAt: env.now(), itemCount: 2 });
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

  it('alerts after two refusals, then once on recovery', async () => {
    const memory = memoryStore([watch()]);
    let status = 403;
    const env = world({ 'https://shop.example/robots.txt': robots(''), 'https://shop.example/sell/ex13': () => status === 200 ? ok(html('a'))() : new Response('', { status }) });
    await run(env, memory.store);
    expect(memory.states.get('w1')?.failures).toBe(1);
    env.advance(memory.states.get('w1')!.retryAt! - env.now());
    const second = await run(env, memory.store);
    expect(second.sent.join()).toContain('refused access (HTTP 403)');
    status = 200;
    env.advance(memory.states.get('w1')!.retryAt! - env.now());
    const third = await run(env, memory.store);
    expect(third.sent.filter(text => text.includes('reachable again'))).toHaveLength(1);
    expect(third.sent.some(text => text.includes('Now watching'))).toBe(true);
    expect(memory.states.get('w1')).toMatchObject({ status: 'ok', alerted: false });
    // A third refusal does not alert again until two more have happened.
    status = 403; env.advance(5 * 60_000);
    expect((await run(env, memory.store)).sent).toEqual([]);
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
