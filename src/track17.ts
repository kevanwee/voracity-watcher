// 17TRACK's tracking API (v2.2): register a number once (that uses quota), then read its
// status as often as needed (free). 17TRACK refreshes each number every 6-12 hours itself.
// Requests are limited to 3 a second and 40 numbers each. Never log tracking numbers.

const BASE = 'https://api.17track.net/track/v2.2';
export const BATCH = 40;
/** 17TRACK's "already registered" rejection, which is fine: tracking continues. */
const ALREADY_REGISTERED = -18019901;

export interface TrackItem { number: string; carrier?: number }
export interface TrackEvent { time: string; text: string; location: string }
export interface TrackInfo {
  number: string;
  carrierKey?: number;
  carrierName?: string;
  status?: string;
  latest?: TrackEvent;
  /** Newest first. */
  events: TrackEvent[];
  eta?: { from?: string; to?: string };
}
export interface Rejection { number: string; code: number; message: string }

type Raw = Record<string, any>;

export class Track17Error extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const event = (raw: Raw | null | undefined): TrackEvent | undefined => raw && raw.description
  ? { time: String(raw.time_iso ?? raw.time_utc ?? ''), text: String(raw.description).slice(0, 300), location: String(raw.location ?? '').slice(0, 120) }
  : undefined;

/** Map one accepted gettrackinfo entry to what Voracity stores. */
export function toInfo(raw: Raw): TrackInfo {
  const info = raw.track_info ?? {};
  const provider = info.tracking?.providers?.[0];
  const events = ((provider?.events ?? []) as Raw[]).map(event).filter((e): e is TrackEvent => !!e).slice(0, 10);
  const eta = info.time_metrics?.estimated_delivery_date;
  return {
    number: String(raw.number), carrierKey: Number(raw.carrier) || provider?.provider?.key || undefined,
    carrierName: provider?.provider?.name ?? undefined, status: info.latest_status?.status ?? undefined,
    latest: event(info.latest_event) ?? events[0], events,
    eta: eta && (eta.from || eta.to) ? { from: eta.from ?? undefined, to: eta.to ?? undefined } : undefined,
  };
}

/**
 * Plain words for 17TRACK's rejections (shown on the parcel in Voracity). Only the
 * "already registered" code is documented, so the rest are recognised by their message.
 */
export function explainRejection(r: Pick<Rejection, 'message'>) {
  const text = r.message.toLowerCase();
  if (/quota|balance|insufficient|limit/.test(text)) return "Ica's 17TRACK allowance has run out, so new parcels can't be added. Existing ones keep updating.";
  if (/carrier/.test(text)) return "17TRACK couldn't match a carrier to this number yet. Ica will keep trying.";
  if (/invalid|format|incorrect/.test(text)) return "17TRACK says this isn't a valid tracking number. Check it on the shop's order page.";
  return "17TRACK couldn't track this number yet. Ica will try again later.";
}

export function track17(apiKey: string, fetcher: typeof fetch = fetch) {
  async function call(path: string, items: TrackItem[]) {
    const response = await fetcher(`${BASE}${path}`, {
      method: 'POST', headers: { '17token': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(items.map(item => (item.carrier ? { number: item.number, carrier: item.carrier } : { number: item.number }))),
    });
    if (!response.ok) throw new Track17Error(`17TRACK returned HTTP ${response.status}`, response.status);
    const body = await response.json() as Raw;
    if (body.code !== 0) throw new Track17Error(`17TRACK returned code ${body.code}`, 200);
    return { accepted: (body.data?.accepted ?? []) as Raw[], rejected: ((body.data?.rejected ?? []) as Raw[]).map((r): Rejection => ({ number: String(r.number), code: Number(r.error?.code), message: String(r.error?.message ?? '') })) };
  }
  return {
    /** Numbers now tracked (including ones already registered) and the ones refused. */
    async register(items: TrackItem[]) {
      const { accepted, rejected } = await call('/register', items);
      const ok = new Set(accepted.map(a => String(a.number)));
      for (const r of rejected) if (r.code === ALREADY_REGISTERED) ok.add(r.number);
      return { registered: ok, rejected: rejected.filter(r => r.code !== ALREADY_REGISTERED) };
    },
    async info(items: TrackItem[]) {
      const { accepted, rejected } = await call('/gettrackinfo', items);
      return { infos: accepted.map(toInfo), rejected };
    },
  };
}
export type Track17 = ReturnType<typeof track17>;
