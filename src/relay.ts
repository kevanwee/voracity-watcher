// Ica's Telegram relay (scripts/apps-script/relay.gs). With it, Telegram pushes messages
// to the owner's Apps Script instead of runners asking Telegram (getUpdates). Runners
// collect queued messages here: the PC every few seconds, GitHub when the relay starts a
// run because the PC is quiet. The relay address and key are a secret (WATCHER_RELAY).
import type { Update } from './listen.ts';

export interface Relay { url: string; key: string }
export interface RelayStatus { pending: number; pcSeenAt: number }

/** Parse WATCHER_RELAY ({"url":"https://script.google.com/macros/s/…/exec","key":"…"}). */
export function parseRelay(raw: string | undefined): Relay | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('WATCHER_RELAY must be JSON like {"url":"https://script.google.com/macros/s/…/exec","key":"…"}'); }
  const { url, key } = (value ?? {}) as Partial<Relay>;
  if (typeof url !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) throw new Error('WATCHER_RELAY needs the web app\'s …/exec URL.');
  if (typeof key !== 'string' || key.length < 32) throw new Error('WATCHER_RELAY needs the key printed by connectTelegram.');
  return { url, key };
}

function address(relay: Relay, params: Record<string, string>) {
  return `${relay.url}?${new URLSearchParams({ key: relay.key, ...params })}`;
}

async function call(relay: Relay, params: Record<string, string>, fetcher: typeof fetch) {
  // Apps Script answers through a redirect to googleusercontent.com, which fetch follows.
  const response = await fetcher(address(relay, params), { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The relay returned HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  if (body.error) throw new Error(`The relay said: ${String(body.error)}`);
  return body;
}

/** Take every queued message (each is handed out once). `who` lets the relay know the PC is listening. */
export async function takeUpdates(relay: Relay, who: 'pc' | 'cloud', fetcher: typeof fetch = fetch): Promise<Update[]> {
  const body = await call(relay, { action: 'take', who }, fetcher);
  return Array.isArray(body.updates) ? body.updates as Update[] : [];
}

export async function relayStatus(relay: Relay, fetcher: typeof fetch = fetch): Promise<RelayStatus> {
  const body = await call(relay, { action: 'status' }, fetcher);
  return { pending: Number(body.pending) || 0, pcSeenAt: Number(body.pcSeenAt) || 0 };
}
