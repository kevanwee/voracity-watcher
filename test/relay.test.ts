import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseRelay, relayStatus, takeUpdates } from '../src/relay.ts';

const URL_OK = 'https://script.google.com/macros/s/AKfycb_x-1/exec';
const KEY = 'k'.repeat(64);

/** Runs scripts/apps-script/relay.gs with stand-ins for Apps Script's services. */
function appsScript(props: Record<string, string> = {}) {
  const store = new Map(Object.entries(props));
  const fetched: { url: string; payload: any }[] = [];
  const logs: string[] = [];
  let clock = 1_800_000_000_000;
  const services = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k: string) => store.get(k) ?? null, setProperty: (k: string, v: string) => { store.set(k, v); },
      deleteProperty: (k: string) => { store.delete(k); }, getProperties: () => Object.fromEntries(store),
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    HtmlService: { createHtmlOutput: (text: string) => ({ kind: 'html', text }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ kind: 'text', text, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch: (url: string, options: { payload: string }) => {
      fetched.push({ url, payload: JSON.parse(options.payload) });
      return { getContentText: () => '{"ok":true}', getResponseCode: () => 204 };
    } },
    Utilities: { getUuid: () => '12345678-1234-1234-1234-123456789abc' },
    console: { log: (line: string) => logs.push(line) },
    Date: class extends Date { static now() { return clock; } },
    JSON, Number, String, Object, Error,
  };
  const context: any = { ...services };
  runInNewContext(readFileSync('scripts/apps-script/relay.gs', 'utf8'), context);
  const post = (update: unknown, key = store.get('RELAY_KEY')) => context.doPost({ parameter: { key }, postData: { contents: JSON.stringify(update) } });
  const get = (params: Record<string, string>) => JSON.parse(context.doGet({ parameter: { key: store.get('RELAY_KEY'), ...params } }).text);
  return { context, store, fetched, logs, post, get, advance: (ms: number) => { clock += ms; } };
}

describe('the Apps Script relay', () => {
  it('connects Telegram to itself and prints the secret for runners', () => {
    const gas = appsScript({ TELEGRAM_BOT_TOKEN: 'T', WEB_APP_URL: URL_OK });
    gas.context.connectTelegram();
    const key = gas.store.get('RELAY_KEY')!;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(gas.fetched[0].url).toBe('https://api.telegram.org/botT/setWebhook');
    expect(gas.fetched[0].payload).toMatchObject({ url: `${URL_OK}?key=${key}`, allowed_updates: ['message', 'callback_query'] });
    expect(gas.logs[0]).toContain(JSON.stringify({ url: URL_OK, key }));
    expect(() => appsScript({ TELEGRAM_BOT_TOKEN: 'T', WEB_APP_URL: 'https://evil.example/exec' }).context.connectTelegram()).toThrow(/WEB_APP_URL/);
  });

  it('queues messages with the right key, answers Telegram with a 200 page, and wakes GitHub only while the PC is quiet', () => {
    const gas = appsScript({ RELAY_KEY: KEY, GITHUB_TOKEN: 'G' });
    expect(gas.post({ update_id: 5 }, 'wrong').text).toBe('no');
    expect([...gas.store.keys()].some(k => k.startsWith('U_'))).toBe(false);
    const reply = gas.post({ update_id: 5, message: { text: 'remind me' } });
    expect(reply.kind).toBe('html'); // HtmlService, so Telegram gets 200 rather than a redirect
    expect(gas.store.has('U_5')).toBe(true);
    expect(gas.fetched.at(-1)).toMatchObject({ url: 'https://api.github.com/repos/kevanwee/voracity-watcher/actions/workflows/watch.yml/dispatches', payload: { ref: 'main', inputs: { messages: 'true' } } });

    // The PC collects, so the next message doesn't start a GitHub run.
    gas.get({ action: 'take', who: 'pc' });
    gas.post({ update_id: 6 });
    expect(gas.fetched).toHaveLength(1);
    gas.advance(21_000);
    gas.post({ update_id: 7 });
    expect(gas.fetched).toHaveLength(2);
  });

  it('hands each message out once, in order, and drops ones older than a day', () => {
    const gas = appsScript({ RELAY_KEY: KEY });
    gas.post({ update_id: 9 });
    gas.post({ update_id: 8 });
    expect(gas.get({ action: 'status' })).toEqual({ pending: 2, pcSeenAt: 0 });
    expect(gas.get({ action: 'take', who: 'cloud' }).updates.map((u: { update_id: number }) => u.update_id)).toEqual([8, 9]);
    expect(gas.get({ action: 'take', who: 'cloud' }).updates).toEqual([]);
    gas.post({ update_id: 10 });
    gas.advance(25 * 3600_000);
    expect(gas.get({ action: 'take', who: 'cloud' }).updates).toEqual([]);
    expect(JSON.parse(gas.context.doGet({ parameter: { key: 'wrong', action: 'take' } }).text)).toEqual({ error: 'forbidden' });
  });
});

describe('the runner side', () => {
  it('reads WATCHER_RELAY strictly', () => {
    expect(parseRelay(undefined)).toBeNull();
    expect(parseRelay(JSON.stringify({ url: URL_OK, key: KEY }))).toEqual({ url: URL_OK, key: KEY });
    expect(() => parseRelay('nope')).toThrow(/must be JSON/);
    expect(() => parseRelay(JSON.stringify({ url: 'https://example.com/exec', key: KEY }))).toThrow(/exec URL/);
    expect(() => parseRelay(JSON.stringify({ url: URL_OK, key: 'short' }))).toThrow(/key/);
  });

  it('takes messages and reads the status with the key', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.includes('action=status') ? { pending: 2, pcSeenAt: 5 } : { updates: [{ update_id: 1 }] }));
    }) as typeof fetch;
    const relay = { url: URL_OK, key: KEY };
    expect(await takeUpdates(relay, 'pc', fetcher)).toEqual([{ update_id: 1 }]);
    expect(await relayStatus(relay, fetcher)).toEqual({ pending: 2, pcSeenAt: 5 });
    expect(urls[0]).toBe(`${URL_OK}?key=${KEY}&action=take&who=pc`);
    const refused = (async () => new Response(JSON.stringify({ error: 'forbidden' }))) as typeof fetch;
    await expect(takeUpdates(relay, 'cloud', refused)).rejects.toThrow('forbidden');
  });
});
