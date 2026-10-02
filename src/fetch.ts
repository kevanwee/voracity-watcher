import { PRODUCT_TOKEN, policyForResponse, type RobotsPolicy } from './robots.ts';

export const VERSION = '1.0.0';
export const USER_AGENT = `${PRODUCT_TOKEN}/${VERSION} (+https://github.com/kevanwee/voracity-watcher)`;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export type PageResult =
  | { kind: 'page'; html: string; etag?: string; lastModified?: string }
  | { kind: 'unchanged' }
  | { kind: 'slow-down'; retryAfterMs?: number; status: number }
  | { kind: 'refused'; status: number }
  | { kind: 'failed'; reason: string };

type Fetcher = typeof fetch;

/** Parse Retry-After as seconds or an HTTP date (RFC 9110 §10.2.3). */
export function retryAfterMs(header: string | null, now = Date.now()) {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Pick a charset from Content-Type, then from an early <meta>, defaulting to UTF-8. */
export function decodeHtml(bytes: Uint8Array, contentType: string | null) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  const charset = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
    ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset.toLowerCase()).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

async function readLimited(response: Response) {
  const length = Number(response.headers.get('content-length'));
  if (length > MAX_BYTES) throw new Error('page is larger than 5 MB');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { await reader.cancel(); throw new Error('page is larger than 5 MB'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const headers = (extra: Record<string, string> = {}) => ({
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  ...extra,
});

/** Fetch an origin's robots.txt. Failures are mapped to RFC 9309's conservative defaults. */
export async function fetchRobots(origin: string, fetcher: Fetcher = fetch): Promise<RobotsPolicy> {
  try {
    const response = await fetcher(origin + '/robots.txt', { headers: headers({ Accept: 'text/plain,*/*;q=0.5' }), redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    const body = response.ok ? decodeHtml(await readLimited(response), response.headers.get('content-type')) : '';
    return policyForResponse(response.status, body);
  } catch {
    return policyForResponse(null, '');
  }
}

/** One polite request for a watched page. No cookies are stored or sent. */
export async function fetchPage(url: string, previous: { etag?: string; lastModified?: string }, fetcher: Fetcher = fetch): Promise<PageResult> {
  const conditional: Record<string, string> = {};
  if (previous.etag) conditional['If-None-Match'] = previous.etag;
  if (previous.lastModified) conditional['If-Modified-Since'] = previous.lastModified;
  let response: Response;
  try {
    response = await fetcher(url, { headers: headers(conditional), redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'could not connect' };
  }
  if (response.status === 304) return { kind: 'unchanged' };
  if (response.status === 429 || response.status === 503) {
    await response.body?.cancel();
    return { kind: 'slow-down', status: response.status, retryAfterMs: retryAfterMs(response.headers.get('retry-after')) };
  }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return { kind: 'refused', status: response.status }; }
  if (!response.ok) { await response.body?.cancel(); return { kind: 'failed', reason: `HTTP ${response.status}` }; }
  const type = response.headers.get('content-type');
  if (type && !/html|xml|text\/plain/i.test(type)) { await response.body?.cancel(); return { kind: 'failed', reason: 'not an HTML page' }; }
  try {
    const html = decodeHtml(await readLimited(response), type);
    return { kind: 'page', html, etag: response.headers.get('etag') ?? undefined, lastModified: response.headers.get('last-modified') ?? undefined };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : 'could not read the page' };
  }
}
