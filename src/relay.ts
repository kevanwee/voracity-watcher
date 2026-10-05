// Ica's Telegram relay (scripts/apps-script/relay.gs). With it, Telegram pushes messages
// to the owner's Apps Script instead of runners asking Telegram (getUpdates). Runners
// collect queued messages here: the PC every few seconds, GitHub when the relay starts a
// run because the PC is quiet. The relay address and key are a secret (WATCHER_RELAY).
import type { Update } from './listen.ts';

export interface Relay { url: string; key: string }
export const PC_ACTIVE_RELAY_MS = 90_000;
export const RELAY_RENEW_MS = 30_000;
export interface RelayStatus { pending: number; pcSeenAt: number; protocol?: number; failed?: number; fault?: { reason: string; at: number; count: number } | null }
export interface ClaimedDelivery { id: string; token: string; until: number; update?: Update; failure?: string; chat?: string }

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
  if (body.error) throw new Error('Relay request refused.');
  return body;
}

/** Fail closed against the old destructive protocol; no implicit fallback. */
export async function claimUpdate(relay: Relay, who: 'pc' | 'cloud', fetcher: typeof fetch = fetch): Promise<ClaimedDelivery | null> {
  const body = await call(relay, { action: 'claim', who }, fetcher);
  if (body.protocol !== 2 || !Array.isArray(body.deliveries) || body.deliveries.length > 1) throw new Error('Relay protocol 2 is required.');
  const d = body.deliveries[0] as ClaimedDelivery | undefined;
  if (!d) return null;
  if (typeof d.id !== 'string' || !/^\d{1,16}$/.test(d.id) || typeof d.token !== 'string' || !/^[a-f0-9]{32}$/.test(d.token)
    || !Number.isSafeInteger(d.until) || (!!d.update === !!d.failure)
    || (d.update && (!Number.isSafeInteger(d.update.update_id) || String(d.update.update_id) !== d.id))
    || (d.failure && (!['expired', 'attempts_exhausted', 'malformed', 'capacity', 'oversized'].includes(d.failure) || typeof d.chat !== 'string'))) throw new Error('Invalid relay claim.');
  return d;
}
export async function finishClaim(relay: Relay, who: 'pc' | 'cloud', d: ClaimedDelivery, action: 'ack' | 'renew', fetcher: typeof fetch = fetch) {
  const body = await call(relay, { action, who, id: d.id, token: d.token }, fetcher);
  if (body.protocol !== 2 || body.ok !== true) throw new Error('Relay claim was not accepted.');
}
export async function relayStatus(relay: Relay, fetcher: typeof fetch = fetch): Promise<RelayStatus> {
  const body = await call(relay, { action: 'status' }, fetcher);
  return { pending: Number(body.pending) || 0, pcSeenAt: Number(body.pcSeenAt) || 0,
    ...(body.protocol === 2 ? { protocol: 2, failed: Number(body.failed) || 0, fault: body.fault as RelayStatus['fault'] } : {}) };
}
