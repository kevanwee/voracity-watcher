import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
/** Runs scripts/apps-script/relay.gs with stand-ins for Apps Script's services. */
export function appsScript(props: Record<string, string> = {}) {
  const store = new Map(Object.entries(props));
  const fetched: { url: string; payload: any }[] = [];
  const logs: string[] = [];
  let serial = 0, dispatchStatus = 204;
  let clock = 1_800_000_000_000;
  const services = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k: string) => store.get(k) ?? null, setProperty: (k: string, v: string) => { store.set(k, v); },
      deleteProperty: (k: string) => { store.delete(k); }, getProperties: () => Object.fromEntries(store),
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    HtmlService: { createHtmlOutput: (text: string) => ({ kind: 'html', text }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ kind: 'text', text, getContent() { return text; }, setMimeType() { return this; } }) },
    UrlFetchApp: { fetch: (url: string, options: { payload: string }) => {
      fetched.push({ url, payload: JSON.parse(options.payload) });
      return { getContentText: () => '{"ok":true}', getResponseCode: () => dispatchStatus };
    } },
    Utilities: { getUuid: () => (++serial).toString(16).padStart(32, '0'), newBlob: (text: string) => ({ getBytes: () => [...Buffer.from(text)] }) },
    console: { log: (line: string) => logs.push(line) },
    Date: class extends Date { static now() { return clock; } },
    JSON, Number, String, Object, Error,
  };
  const context: any = { ...services };
  runInNewContext(readFileSync('scripts/apps-script/relay.gs', 'utf8'), context);
  const post = (update: unknown, key = store.get('RELAY_KEY')) => context.doPost({ parameter: { key }, postData: { contents: JSON.stringify(update) } });
  const get = (params: Record<string, string>) => JSON.parse(context.doGet({ parameter: { key: store.get('RELAY_KEY'), ...params } }).text);
  return { context, store, fetched, logs, post, get, clock: () => clock, dispatchStatus: (status: number) => { dispatchStatus = status; }, advance: (ms: number) => { clock += ms; } };
}
