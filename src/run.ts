import { SelectorError, diffItems, extractItems, isEmptyDiff, summarise } from './extract.ts';
import { VERSION, fetchPage, fetchRobots } from './fetch.ts';
import { isAllowed, type RobotsPolicy } from './robots.ts';
import { baselineMessage, changeMessage, problemMessage, recoveredMessage, testMessage } from './telegram.ts';

// Mirrors Voracity's src/watcher/watch-model.ts and firestore.rules.
export interface Watch { id: string; label: string; url: string; selector: string; ignore: string; interval: number; enabled: boolean; createdAt: number }
export interface WatchState { status: 'ok' | 'error'; checkedAt: number; changedAt?: number; itemCount?: number; summary?: string; error?: string; failures?: number; retryAt?: number; alerted?: boolean }
export interface ItemsDoc { items: string[]; url: string; selector: string; ignore: string; etag?: string; lastModified?: string }

export interface Store {
  watches(uid: string): Promise<Watch[]>;
  states(uid: string): Promise<Map<string, WatchState>>;
  items(uid: string): Promise<Map<string, ItemsDoc>>;
  save(uid: string, id: string, state: WatchState, items?: ItemsDoc): Promise<void>;
  removeItems(uid: string, id: string): Promise<void>;
  heartbeat(uid: string, at: number): Promise<void>;
}

export interface Deps {
  owners: Record<string, string>;
  store: Store;
  send: (chatId: string, text: string) => Promise<void>;
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  test?: boolean;
  /** Stop starting new checks after this long, so runs never overlap the next schedule. */
  budgetMs?: number;
}

export const MIN_SPACING_MS = 3_000;
export const MAX_PER_HOST = 5;
export const MAX_PER_OWNER = 30;
const DAY = 86_400_000;
// Scheduled runs start late; treat a watch as due slightly early so a 5-minute watch is not skipped every other run.
const GRACE_MS = 90_000;

export function isDue(watch: Watch, state: WatchState | undefined, now: number) {
  if (!watch.enabled) return false;
  if (state?.retryAt && now < state.retryAt) return false;
  return !state || now - state.checkedAt >= watch.interval * 60_000 - GRACE_MS;
}

/** Exponential backoff from the watch's own interval, capped at a day. */
export function backoff(watch: Watch, failures: number, retryAfterMs = 0) {
  return Math.max(retryAfterMs, Math.min(DAY, watch.interval * 60_000 * 2 ** Math.max(0, failures - 1)));
}

/** Requests to one host are spaced by its Crawl-delay (at least 3 s); a slow host gets fewer checks per run. */
export function hostLimits(policy: RobotsPolicy) {
  const spacing = Math.max(MIN_SPACING_MS, (policy.crawlDelay ?? 0) * 1000);
  return { spacing, perRun: Math.max(1, Math.min(MAX_PER_HOST, Math.floor(120_000 / spacing))) };
}

const hostOf = (url: string) => new URL(url).host.toLowerCase();

export async function runOnce(deps: Deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});
  const started = now(), budget = deps.budgetMs ?? 240_000;
  const robots = new Map<string, Promise<RobotsPolicy>>();
  const lastRequest = new Map<string, number>();
  const perHost = new Map<string, number>();
  const totals = { due: 0, checked: 0, changed: 0, failed: 0, postponed: 0, notified: 0, sendFailures: 0 };

  async function politely<T>(host: string, spacing: number, request: () => Promise<T>) {
    const wait = (lastRequest.get(host) ?? -Infinity) + spacing - now();
    if (wait > 0) await sleep(wait);
    try { return await request(); } finally { lastRequest.set(host, now()); }
  }
  async function policyFor(url: URL) {
    const host = url.host.toLowerCase();
    if (!robots.has(host)) robots.set(host, politely(host, MIN_SPACING_MS, () => fetchRobots(url.origin, deps.fetcher)));
    return robots.get(host)!;
  }

  for (const [ownerIndex, [uid, chatId]] of Object.entries(deps.owners).entries()) {
    const notify = async (text: string) => {
      try { await deps.send(chatId, text); totals.notified++; return true; } catch { totals.sendFailures++; return false; }
    };
    const [watches, states, itemDocs] = await Promise.all([deps.store.watches(uid), deps.store.states(uid), deps.store.items(uid)]);
    const known = new Set(watches.map(watch => watch.id));
    for (const id of itemDocs.keys()) if (!known.has(id)) await deps.store.removeItems(uid, id);
    if (deps.test) await notify(testMessage(watches.filter(watch => watch.enabled).length));

    const due = watches.slice(0, MAX_PER_OWNER).filter(watch => isDue(watch, states.get(watch.id), now()))
      .sort((a, b) => (states.get(a.id)?.checkedAt ?? 0) - (states.get(b.id)?.checkedAt ?? 0));
    totals.due += due.length;

    for (const watch of due) {
      if (now() - started > budget) { totals.postponed++; continue; }
      let url: URL, host: string;
      try { url = new URL(watch.url); host = hostOf(watch.url); } catch { continue; }
      const previousState = states.get(watch.id), previous = itemDocs.get(watch.id);
      const sameSettings = previous && previous.url === watch.url && previous.selector === watch.selector && previous.ignore === watch.ignore;
      const policy = await policyFor(url);
      const { spacing, perRun } = hostLimits(policy);
      if ((perHost.get(host) ?? 0) >= perRun) { totals.postponed++; continue; }

      const fail = async (problem: string, notifyAfter: number, retryAfterMs = 0) => {
        totals.failed++;
        const failures = (previousState?.status === 'error' ? previousState.failures ?? 1 : 0) + 1;
        let alerted = previousState?.alerted ?? false;
        if (failures >= notifyAfter && !alerted) alerted = await notify(problemMessage(watch.label, watch.url, problem));
        await deps.store.save(uid, watch.id,
          { ...carry(previousState), status: 'error', checkedAt: now(), error: problem, failures, retryAt: now() + backoff(watch, failures, retryAfterMs), alerted });
      };

      if (policy.unavailable) { await fail("the site's robots.txt is temporarily unavailable, so checks are paused", 3); continue; }
      if (!isAllowed(policy, url)) { await fail("the site's robots.txt does not allow automated checks of this page", 1, DAY); continue; }

      perHost.set(host, (perHost.get(host) ?? 0) + 1);
      totals.checked++;
      const result = await politely(host, spacing, () => fetchPage(watch.url, sameSettings ? previous : {}, deps.fetcher));
      if (result.kind === 'slow-down') { await fail(`the site asked us to slow down (HTTP ${result.status})`, 3, result.retryAfterMs); continue; }
      if (result.kind === 'refused') { await fail(`the site refused access (HTTP ${result.status})`, 2); continue; }
      if (result.kind === 'failed') { await fail(result.reason, 3); continue; }

      // An unsent recovery notice is retried on the next successful check.
      const alerted = previousState?.alerted ? !(await notify(recoveredMessage(watch.label, watch.url))) : false;
      if (result.kind === 'unchanged' && previous) {
        await deps.store.save(uid, watch.id, { ...carry(previousState), status: 'ok', checkedAt: now(), itemCount: previous.items.length, failures: 0, alerted });
        continue;
      }
      if (result.kind !== 'page') continue;
      let items: string[];
      try { items = extractItems(result.html, watch.selector, watch.ignore); }
      catch (error) { await fail(error instanceof SelectorError ? error.message : 'could not read the page', 1); continue; }

      const next: ItemsDoc = { items, url: watch.url, selector: watch.selector, ignore: watch.ignore, etag: result.etag, lastModified: result.lastModified };
      const base = { ...carry(previousState), status: 'ok' as const, checkedAt: now(), itemCount: items.length, failures: 0, alerted };
      if (!sameSettings) {
        // First check, or the address/selector changed: record a fresh baseline.
        await notify(baselineMessage(watch.label, watch.url, items.length, watch.selector));
        await deps.store.save(uid, watch.id, base, next);
        continue;
      }
      const diff = diffItems(previous.items, items);
      if (isEmptyDiff(diff)) {
        // Rewrite the snapshot only when its validators changed, to stay well inside Firestore's free write quota.
        const validators = previous.etag !== next.etag || previous.lastModified !== next.lastModified;
        await deps.store.save(uid, watch.id, base, validators ? next : undefined);
        continue;
      }
      totals.changed++;
      // Keep the old snapshot if Telegram is unreachable, so the change is reported next run.
      if (await notify(changeMessage(watch.label, watch.url, diff))) {
        await deps.store.save(uid, watch.id, { ...base, changedAt: now(), summary: summarise(diff) }, next);
      } else {
        await deps.store.save(uid, watch.id, { ...base, itemCount: previous.items.length }, undefined);
      }
    }
    await deps.store.heartbeat(uid, now());
    // Counts only: public Actions logs must never contain addresses, owners or page content.
    log(`owner ${ownerIndex + 1}: ${watches.length} watches`);
  }
  log(`due ${totals.due}, checked ${totals.checked}, changed ${totals.changed}, failed ${totals.failed}, postponed ${totals.postponed}, messages ${totals.notified}, message failures ${totals.sendFailures}`);
  return totals;
}

/** Keep the last change details across checks. */
function carry(state?: WatchState): Partial<WatchState> {
  return state ? { changedAt: state.changedAt, summary: state.summary } : {};
}

export { VERSION };
