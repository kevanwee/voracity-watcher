import { describe, expect, it, vi } from 'vitest';
import { claimUpdate, finishClaim, parseRelay, relayStatus } from '../src/relay.ts';
import { relayRound, type ListenDeps } from '../src/listen.ts';
import { appsScript } from './relay-simulator.ts';
const URL_OK = 'https://script.google.com/macros/s/AKfycb_x-1/exec', KEY = 'k'.repeat(64);
const message = (id: number, text = 'note: hello') => ({ update_id: id, message: { text, date: 1800000000, chat: { id: 42 } } });
const configured = () => appsScript({ RELAY_KEY: KEY, GITHUB_TOKEN: 'G' });
const claim = (gas: ReturnType<typeof configured>, who = 'cloud') => gas.get({ action: 'claim', who }).deliveries[0];
const finish = (gas: ReturnType<typeof configured>, d: any, action = 'ack', who = 'cloud') => gas.get({ action, who, id: d.id, token: d.token });

describe('Apps Script durable relay', () => {
  it('configures Telegram without dropping pending updates', () => {
    const gas = appsScript({ TELEGRAM_BOT_TOKEN: 'T', WEB_APP_URL: URL_OK });
    gas.context.connectTelegram();
    const key = gas.store.get('RELAY_KEY')!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(gas.fetched[0].payload).toMatchObject({ url: `${URL_OK}?key=${key}`, allowed_updates: ['message', 'callback_query'] });
  });
  it('rejects incorrect or missing auth and refuses destructive old clients', () => {
    const gas = configured();
    expect(gas.post(message(1), 'wrong').text).toBe('no');
    expect(gas.get({ action: 'claim', who: 'cloud', key: 'wrong' })).toEqual({ error: 'forbidden' });
    expect(appsScript().post(message(1)).text).toBe('no');
    gas.post(message(1));
    expect(gas.get({ action: 'take', who: 'pc' })).toEqual({ error: 'protocol_upgrade_required' });
    expect(gas.get({ action: 'status' }).pending).toBe(1);
    expect(gas.get({ action: 'claim', who: 'other' })).toEqual({ error: 'invalid_runner' });
  });
  it('deduplicates webhooks while pending, claimed, and after acknowledgment', () => {
    const gas = configured();
    gas.post(message(9)); gas.post(message(8)); gas.post(message(8));
    const d = claim(gas);
    expect(d.update.update_id).toBe(8);
    gas.post(message(8));
    expect(claim(gas).update.update_id).toBe(9);
    expect(claim(gas)).toBeUndefined();
    expect(finish(gas, d)).toMatchObject({ ok: true });
    expect(finish(gas, d)).toMatchObject({ ok: true }); // Lost ACK response.
    gas.post(message(8));
    expect(claim(gas)).toBeUndefined();
  });
  it('recovers a lost claim and rejects stale ack/renew and the wrong runner', () => {
    const gas = configured(); gas.post(message(1));
    const lost = claim(gas, 'pc');
    expect(claim(gas)).toBeUndefined();
    gas.advance(121000);
    const next = claim(gas);
    expect(next.id).toBe(lost.id); expect(next.token).not.toBe(lost.token);
    expect(finish(gas, lost, 'ack', 'pc')).toEqual({ error: 'stale_claim' });
    expect(finish(gas, lost, 'renew', 'pc')).toEqual({ error: 'stale_claim' });
    expect(finish(gas, next, 'ack', 'pc')).toEqual({ error: 'stale_claim' });
    expect(finish(gas, next)).toMatchObject({ ok: true });
  });
  it('keeps long PC work leased and protects new messages from cloud takeover', () => {
    const gas = configured(); gas.post(message(1));
    const d = claim(gas, 'pc');
    for (let i = 0; i < 12; i++) { gas.advance(30000); expect(finish(gas, d, 'renew', 'pc')).toMatchObject({ ok: true }); }
    gas.post(message(2));
    expect(claim(gas)).toBeUndefined();
    expect(finish(gas, d, 'ack', 'pc')).toMatchObject({ ok: true });
    expect(claim(gas, 'pc').id).toBe('2');
  });
  it('records expiry and exhausted attempts as notices, never fresh work', () => {
    const gas = configured(); gas.post(message(1));
    for (let i = 0; i < 5; i++) { expect(claim(gas).update.update_id).toBe(1); gas.advance(121000); }
    const failed = claim(gas);
    expect(failed).toMatchObject({ failure: 'attempts_exhausted', chat: '42' });
    finish(gas, failed); gas.post(message(1));
    expect(claim(gas)).toBeUndefined();
    gas.post(message(2)); gas.advance(86400001);
    expect(claim(gas)).toMatchObject({ failure: 'expired' });
    expect(gas.get({ action: 'status' }).failed).toBe(2);
    gas.advance(7 * 86400000 + 1); gas.get({ action: 'status' });
    expect(gas.store.has('U_1')).toBe(false);
  });
  it('fits Unicode payloads into properties and explicitly rejects oversized input', () => {
    const gas = configured();
    const unicode = '\u{1f600}'.repeat(4096);
    expect(Buffer.byteLength(unicode)).toBe(16384);
    gas.post(message(1, unicode));
    for (const value of gas.store.values()) expect(Buffer.byteLength(value)).toBeLessThan(9000);
    expect(claim(gas).update.message.text).toBe(unicode);
    gas.post(message(2, 'x'.repeat(25000)));
    expect(claim(gas).failure).toBe('oversized');
  });
  it('keeps accepted work when full, including shared-property storage pressure', () => {
    const gas = configured();
    for (let id = 1; id <= 64; id++) gas.post(message(id));
    gas.post(message(65));
    expect(gas.get({ action: 'status' })).toMatchObject({ pending: 64, failed: 1 });
    expect(JSON.parse(gas.store.get('U_1')!).state).toBe('pending');
    const full = configured(); full.store.set('OTHER', 'x'.repeat(299000)); full.post(message(2));
    expect(claim(full).failure).toBe('capacity');
  });
  it('has a bounded fault record when receipt admission is full', () => {
    const gas = configured();
    for (let id = 0; id < 512; id++) gas.store.set('U_' + id, JSON.stringify({ v: 2, at: gas.clock(), ended: gas.clock(), state: 'done' }));
    expect(gas.post(message(600)).text).toBe('rejected');
    expect(gas.get({ action: 'status' }).fault).toMatchObject({ reason: 'capacity', count: 1 });
    expect([...gas.store.keys()].filter(k => k.startsWith('U_'))).toHaveLength(512);
  });
  it('quarantines malformed entries and incomplete payloads without blocking the next message', () => {
    const gas = configured(); gas.store.set('U_1', '{broken'); gas.post(message(2));
    expect(claim(gas).failure).toBe('malformed');
    const d = claim(gas); expect(d.update.update_id).toBe(2);
    gas.post(message(3)); gas.store.delete('P_3_0');
    expect(claim(gas).failure).toBe('malformed');
  });
  it('exposes safe private health diagnostics without payloads or credentials', () => {
    const gas = configured(); gas.post(message(1, 'private synthetic body')); gas.context.relayHealth();
    const logged = gas.logs.join('');
    expect(JSON.parse(logged)).toMatchObject({ protocol: 2, pending: 1 });
    expect(logged).not.toContain(KEY); expect(logged).not.toContain('private synthetic body');
  });
  it('recovers admission after the payload write failed before its commit marker', () => {
    const gas = configured(); gas.store.set('P_1_0', 'orphan');
    gas.post(message(1));
    expect(claim(gas).update).toEqual(message(1));
  });
  it('migrates a legacy pending entry and keeps work after dispatch failure', () => {
    const gas = configured(); gas.store.set('U_1', JSON.stringify({ at: gas.clock() - 5000, update: message(1) }));
    expect(claim(gas).update).toEqual(message(1));
    gas.dispatchStatus(500); expect(gas.post(message(2)).text).toBe('ok');
    expect(gas.get({ action: 'status' })).toMatchObject({ pending: 2, fault: { reason: 'dispatch' } });
    expect(claim(gas).update.update_id).toBe(2);
  });
});

function runner(gas: ReturnType<typeof configured>) {
  const fetcher = (async (url: string | URL) => new Response(JSON.stringify(gas.get(Object.fromEntries(new URL(String(url)).searchParams)))) ) as typeof fetch;
  const relay = { url: URL_OK, key: KEY };
  return { fetcher, relay, deps: { relay, fetcher, owners: { owner: '42' }, token: 'synthetic', base: {}, store: {} as ListenDeps['store'] } satisfies ListenDeps };
}
describe('runner protocol and fault injection', () => {
  it('parses secrets strictly and refuses old or malformed protocol responses', async () => {
    expect(parseRelay(undefined)).toBeNull();
    expect(parseRelay(JSON.stringify({ url: URL_OK, key: KEY }))).toEqual({ url: URL_OK, key: KEY });
    expect(() => parseRelay('nope')).toThrow();
    expect(() => parseRelay(JSON.stringify({ url: 'https://evil.test', key: KEY }))).toThrow();
    expect(() => parseRelay(JSON.stringify({ url: URL_OK, key: 'short' }))).toThrow();
    for (const response of [{ updates: [message(1)] }, { protocol: 2, deliveries: [{ id: '1' }] }]) {
      await expect(claimUpdate({ url: URL_OK, key: KEY }, 'cloud', (async () => new Response(JSON.stringify(response))) as typeof fetch)).rejects.toThrow();
    }
  });
  it('does not ACK a failed handler; another runner recovers after expiry', async () => {
    const gas = configured(), r = runner(gas); gas.post(message(1));
    await relayRound(r.deps, 'pc', async () => { throw new Error('crash'); });
    expect((await relayStatus(r.relay, r.fetcher)).pending).toBe(1);
    gas.advance(121000);
    const seen: number[] = [];
    await relayRound(r.deps, 'cloud', async u => { seen.push(u.update_id); });
    expect(seen).toEqual([1]); expect((await relayStatus(r.relay, r.fetcher)).pending).toBe(0);
  });
  it('retains work when the claim response is lost', async () => {
    const gas = configured(), r = runner(gas); gas.post(message(1));
    await expect(claimUpdate(r.relay, 'cloud', (async url => { await r.fetcher(url); throw new Error('lost response'); }) as typeof fetch)).rejects.toThrow();
    expect(await claimUpdate(r.relay, 'cloud', r.fetcher)).toBeNull();
    gas.advance(121000);
    expect((await claimUpdate(r.relay, 'cloud', r.fetcher))?.id).toBe('1');
  });
  it('renews during a slow handler and stops the timer afterwards', async () => {
    vi.useFakeTimers();
    try {
      const gas = configured(), r = runner(gas); gas.post(message(1));
      let release!: () => void;
      const waiting = new Promise<void>(resolve => { release = resolve; });
      const running = relayRound(r.deps, 'pc', () => waiting);
      await vi.advanceTimersByTimeAsync(1);
      for (let i = 0; i < 8; i++) { gas.advance(30000); await vi.advanceTimersByTimeAsync(30000); }
      gas.post(message(2)); expect(claim(gas)).toBeUndefined();
      release(); await running;
      expect(JSON.parse(gas.store.get('U_1')!).state).toBe('done');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('does not ACK after a lost renewal and fences a stale completion', async () => {
    const gas = configured(), r = runner(gas); gas.post(message(1));
    const first = await claimUpdate(r.relay, 'pc', r.fetcher);
    gas.advance(121000); await claimUpdate(r.relay, 'cloud', r.fetcher);
    await expect(finishClaim(r.relay, 'pc', first!, 'ack', r.fetcher)).rejects.toThrow();
  });
});
