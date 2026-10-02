import { SelectorError, diffItems, extractItems, isEmptyDiff, summarise } from './extract.ts';
import { VERSION, fetchPage, fetchRobots } from './fetch.ts';
import { isAllowed, type RobotsPolicy } from './robots.ts';
import { baselineMessage, changeMessage, handoffMessage, problemMessage, recoveredMessage, testMessage } from './telegram.ts';

// Mirrors Voracity's src/watcher/watch-model.ts and firestore.rules.
export interface Watch {
  id: string; label: string; url: string; selector: string; ignore: string; interval: number; enabled: boolean; createdAt: number;
  /** 'local' sends the watch straight to the owner's computer; 'auto' (default) starts in the cloud. */
  runOn?: 'auto' | 'local';
}
export type Runner = 'cloud' | 'local';
export interface WatchState {
  status: 'ok' | 'error'; checkedAt: number; changedAt?: number; itemCount?: number; summary?: string; error?: string; failures?: number; retryAt?: number; alerted?: boolean;
  /** Which runner checks this watch. Absent means the cloud (GitHub Actions) runner. */
  route?: Runner;
  /** Consecutive 401/403 refusals seen by the cloud runner; two move the watch to the local runner for good. */
  cloudRefusals?: number;
  /** When the watch moved to the local runner. The cloud runner never contacts it again. */
  movedAt?: number;
}
export interface ItemsDoc { items: string[]; url: string; selector: string; ignore: string; etag?: string; lastModified?: string }

export interface Store {
  watches(uid: string): Promise<Watch[]>;
  states(uid: string): Promise<Map<string, WatchState>>;
  items(uid: string): Promise<Map<string, ItemsDoc>>;
  save(uid: string, id: string, state: WatchState, items?: ItemsDoc): Promise<void>;
  removeItems(uid: string, id: string): Promise<void>;
  heartbeat(uid: string, at: number, runner: Runner): Promise<void>;
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
  /** 'cloud' for GitHub Actions (the default), 'local' for the owner's computer. */
  runner?: Runner;
  /**
   * A check the owner asked for (Telegram /check): ignores each watch's interval but
   * still honours backoff, Retry-After and a one-minute per-watch cooldown.
   */
  manual?: { uid: string; match?: (watch: Watch) => boolean };
  /** Stop starting new checks after this long, so runs never overlap the next schedule. */
  budgetMs?: number;
}

export const MIN_SPACING_MS = 3_000;
export const MAX_PER_HOST = 5;
export const MAX_PER_OWNER = 30;
const DAY = 86_400_000;
/** Cloud refusals in a row before a watch moves to the local runner. */
export const HANDOFF_AFTER = 2;
/** A watch can be checked on request at most this often. */
export const MANUAL_COOLDOWN_MS = 60_000;

export type OutcomeKind = 'changed' | 'unchanged' | 'baseline' | 'failed' | 'moved' | 'waiting';
export interface Outcome { label: string; kind: OutcomeKind; detail: string }

/**
 * A 401/403 refusal recorded by the cloud runner before hand-offs existed (no
 * cloudRefusals field). Treated as already handed over, so the cloud never asks again.
 */
export const legacyCloudRefusal = (state?: WatchState) =>
  !!state && !state.route && state.cloudRefusals === undefined && state.status === 'error' && /^the site refused access \(HTTP 40[13]\)/.test(state.error ?? '');

export const routeOf = (state: WatchState | undefined, watch?: Watch): Runner =>
  watch?.runOn === 'local' || legacyCloudRefusal(state) ? 'local' : state?.route ?? 'cloud';

/**
 * Watches this runner should check now. Each runner only checks watches routed to it,
 * so a watch is never fetched by both. A moved watch is never retried from the cloud,
 * because repeatedly requesting a site that refuses data-centre IPs risks a wider ban.
 */
export function selectDue(watches: Watch[], states: Map<string, WatchState>, runner: Runner, now: number) {
  return watches.slice(0, MAX_PER_OWNER)
    .filter(watch => routeOf(states.get(watch.id), watch) === runner && isDue(watch, states.get(watch.id), now))
    .sort((a, b) => (states.get(a.id)?.checkedAt ?? 0) - (states.get(b.id)?.checkedAt ?? 0));
}

/** Watches a requested check covers, and the ones it must leave alone (with why). */
export function selectManual(watches: Watch[], states: Map<string, WatchState>, runner: Runner, now: number, match: (watch: Watch) => boolean = () => true) {
  const due: Watch[] = [], waiting: Outcome[] = [];
  for (const watch of watches.slice(0, MAX_PER_OWNER)) {
    const state = states.get(watch.id);
    if (!watch.enabled || !match(watch) || routeOf(state, watch) !== runner) continue;
    if (state?.retryAt && now < state.retryAt) waiting.push({ label: watch.label, kind: 'waiting', detail: `backing off until ${clock(state.retryAt)} (${state.error ?? 'earlier failure'})` });
    else if (state && now - state.checkedAt < MANUAL_COOLDOWN_MS) waiting.push({ label: watch.label, kind: 'waiting', detail: 'checked less than a minute ago' });
    else due.push(watch);
  }
  return { due, waiting };
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Asia/Singapore' });
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
  const runner: Runner = deps.runner ?? 'cloud';
  const started = now(), budget = deps.budgetMs ?? 240_000;
  const robots = new Map<string, Promise<RobotsPolicy>>();
  const lastRequest = new Map<string, number>();
  const perHost = new Map<string, number>();
  const totals = { due: 0, checked: 0, changed: 0, failed: 0, postponed: 0, moved: 0, notified: 0, sendFailures: 0, outcomes: [] as Outcome[] };
  const record = (watch: Watch, kind: OutcomeKind, detail: string) => { totals.outcomes.push({ label: watch.label, kind, detail }); };

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
    if (deps.manual && deps.manual.uid !== uid) continue;
    const notify = async (text: string) => {
      try { await deps.send(chatId, text); totals.notified++; return true; } catch { totals.sendFailures++; return false; }
    };
    const [watches, states, itemDocs] = await Promise.all([deps.store.watches(uid), deps.store.states(uid), deps.store.items(uid)]);
    const known = new Set(watches.map(watch => watch.id));
    for (const id of itemDocs.keys()) if (!known.has(id)) await deps.store.removeItems(uid, id);
    if (deps.test) await notify(testMessage(watches.filter(watch => watch.enabled).length, runner));

    let due: Watch[];
    if (deps.manual) {
      const picked = selectManual(watches, states, runner, now(), deps.manual.match);
      due = picked.due;
      totals.outcomes.push(...picked.waiting);
    } else due = selectDue(watches, states, runner, now());
    totals.due += due.length;

    for (const watch of due) {
      if (now() - started > budget) { totals.postponed++; record(watch, 'waiting', 'postponed to the next run'); continue; }
      let url: URL, host: string;
      try { url = new URL(watch.url); host = hostOf(watch.url); } catch { continue; }
      let previousState = states.get(watch.id);
      const previous = itemDocs.get(watch.id);
      if (runner === 'local' && legacyCloudRefusal(previousState)) {
        // Record the hand-off so it survives this watch's next successful check.
        previousState = { ...previousState!, route: 'local', movedAt: now() };
        await deps.store.save(uid, watch.id, previousState);
      }
      const sameSettings = previous && previous.url === watch.url && previous.selector === watch.selector && previous.ignore === watch.ignore;
      const policy = await policyFor(url);
      const { spacing, perRun } = hostLimits(policy);
      if ((perHost.get(host) ?? 0) >= perRun) { totals.postponed++; record(watch, 'waiting', "postponed: the site's request limit for this run is used up"); continue; }

      const fail = async (problem: string, notifyAfter: number, retryAfterMs = 0) => {
        totals.failed++;
        record(watch, 'failed', problem);
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
      if (result.kind === 'refused' && runner === 'cloud') {
        // Many sites block data-centre IP ranges. Move the watch to the owner's computer rather than evade the block.
        const refusals = (previousState?.cloudRefusals ?? 0) + 1;
        if (refusals >= HANDOFF_AFTER) {
          totals.moved++;
          record(watch, 'moved', "the site refuses GitHub's servers; your PC checks it now");
          await notify(handoffMessage(watch.label, watch.url, result.status));
          await deps.store.save(uid, watch.id, { ...carry(previousState), status: 'error', checkedAt: now(), failures: 0, alerted: false,
            error: `the site refuses GitHub's servers (HTTP ${result.status}); your PC checks it now`, route: 'local', cloudRefusals: 0, movedAt: now() });
        } else {
          totals.failed++;
          record(watch, 'failed', `the site refused access (HTTP ${result.status})`);
          await deps.store.save(uid, watch.id, { ...carry(previousState), status: 'error', checkedAt: now(), error: `the site refused access (HTTP ${result.status})`,
            failures: (previousState?.failures ?? 0) + 1, alerted: previousState?.alerted, cloudRefusals: refusals });
        }
        continue;
      }
      if (result.kind === 'refused') { await fail(`the site refused access (HTTP ${result.status})`, 2); continue; }
      if (result.kind === 'failed') { await fail(result.reason, 3); continue; }

      // An unsent recovery notice is retried on the next successful check.
      const alerted = previousState?.alerted ? !(await notify(recoveredMessage(watch.label, watch.url))) : false;
      if (result.kind === 'unchanged' && previous) {
        record(watch, 'unchanged', `no change (${count(previous.items.length)})`);
        await deps.store.save(uid, watch.id, { ...carry(previousState), status: 'ok', checkedAt: now(), itemCount: previous.items.length, failures: 0, alerted, ...(runner === 'cloud' ? { cloudRefusals: 0 } : {}) });
        continue;
      }
      if (result.kind !== 'page') continue;
      let items: string[];
      try { items = extractItems(result.html, watch.selector, watch.ignore); }
      catch (error) { await fail(error instanceof SelectorError ? error.message : 'could not read the page', 1); continue; }

      const next: ItemsDoc = { items, url: watch.url, selector: watch.selector, ignore: watch.ignore, etag: result.etag, lastModified: result.lastModified };
      const base = { ...carry(previousState), status: 'ok' as const, checkedAt: now(), itemCount: items.length, failures: 0, alerted, ...(runner === 'cloud' ? { cloudRefusals: 0 } : {}) };
      if (!sameSettings) {
        // First check, or the address/selector changed: record a fresh baseline.
        record(watch, 'baseline', `now watching (${count(items.length)})`);
        await notify(baselineMessage(watch.label, watch.url, items.length, watch.selector));
        await deps.store.save(uid, watch.id, base, next);
        continue;
      }
      const diff = diffItems(previous.items, items);
      if (isEmptyDiff(diff)) {
        record(watch, 'unchanged', `no change (${count(items.length)})`);
        // Rewrite the snapshot only when its validators changed, to stay well inside Firestore's free write quota.
        const validators = previous.etag !== next.etag || previous.lastModified !== next.lastModified;
        await deps.store.save(uid, watch.id, base, validators ? next : undefined);
        continue;
      }
      totals.changed++;
      record(watch, 'changed', summarise(diff));
      // Keep the old snapshot if Telegram is unreachable, so the change is reported next run.
      if (await notify(changeMessage(watch.label, watch.url, diff))) {
        await deps.store.save(uid, watch.id, { ...base, changedAt: now(), summary: summarise(diff) }, next);
      } else {
        await deps.store.save(uid, watch.id, { ...base, itemCount: previous.items.length }, undefined);
      }
    }
    await deps.store.heartbeat(uid, now(), runner);
    // Counts only: public Actions logs must never contain addresses, owners or page content.
    log(`owner ${ownerIndex + 1}: ${watches.length} watches`);
  }
  log(`${runner} runner: due ${totals.due}, checked ${totals.checked}, changed ${totals.changed}, failed ${totals.failed}, postponed ${totals.postponed}, moved ${totals.moved}, messages ${totals.notified}, message failures ${totals.sendFailures}`);
  return totals;
}

const count = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** Keep the last change details and routing across checks. */
function carry(state?: WatchState): Partial<WatchState> {
  return state ? { changedAt: state.changedAt, summary: state.summary, route: state.route, cloudRefusals: state.cloudRefusals, movedAt: state.movedAt } : {};
}

export { VERSION };
