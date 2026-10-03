// Parcels from Voracity's users/{uid}/parcels: registered with 17TRACK, checked every 30
// minutes (daily once delivered), and announced on Telegram when their status or latest
// event changes. Tracking state goes to parcelState/{id}. Logs are counts only: tracking
// numbers and names are personal and this repository's logs are public.
import { escapeHtml } from './telegram.ts';
import { BATCH, explainRejection, type Track17, type TrackEvent, type TrackInfo } from './track17.ts';

/** Matches Voracity's src/parcels/parcel-model.ts and firestore.rules (validParcel). */
export interface Parcel { id: string; number: string; label: string; carrier: number; archived: boolean; createdAt: number; updatedAt: number; revision: number }
export interface ParcelState {
  registered: boolean;
  status?: string;
  carrierName?: string;
  carrierKey?: number;
  latest?: TrackEvent;
  events?: TrackEvent[];
  eta?: { from?: string; to?: string };
  checkedAt?: number;
  changedAt?: number;
  error?: string;
  registerAttemptAt?: number;
}
export interface ParcelStore {
  parcels(uid: string): Promise<Parcel[]>;
  parcelStates(uid: string): Promise<Map<string, ParcelState>>;
  saveParcelState(uid: string, id: string, state: ParcelState): Promise<void>;
  createParcel(uid: string, parcel: Parcel): Promise<void>;
}

export const POLL_MS = 30 * 60_000;
const SETTLED_POLL_MS = 24 * 3_600_000;
/** A refused registration costs no quota; try again after this long. */
export const RETRY_REGISTER_MS = 6 * 3_600_000;
export const NOT_CONFIGURED = "Ica isn't set up to track parcels yet: add the TRACK17_API_KEY secret to voracity-watcher (see its README).";

/** Keep in step with Voracity's STATUS_LABEL. */
export const STATUS_LABEL: Record<string, string> = {
  NotFound: 'Waiting for the carrier', InfoReceived: 'Label created', InTransit: 'In transit', AvailableForPickup: 'Ready to collect',
  OutForDelivery: 'Out for delivery', DeliveryFailure: 'Delivery attempt failed', Delivered: 'Delivered', Exception: 'Problem with delivery',
  Expired: 'No updates for a long time',
};
const URGENT = new Set(['OutForDelivery', 'AvailableForPickup', 'DeliveryFailure', 'Exception']);
export const trackingPage = (number: string) => `https://t.17track.net/en#nums=${encodeURIComponent(number)}`;

const pollEvery = (status?: string) => (status === 'Delivered' || status === 'Expired' ? SETTLED_POLL_MS : POLL_MS);
const chunks = <T,>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));
/** Firestore refuses undefined fields. */
const clean = (state: ParcelState) => JSON.parse(JSON.stringify(state)) as ParcelState;
const key = (state: ParcelState | undefined) => `${state?.status ?? ''}|${state?.latest?.time ?? ''}|${state?.latest?.text ?? ''}`;

function eventLine(event?: TrackEvent) {
  return event ? `${escapeHtml(event.text)}${event.location ? `, ${escapeHtml(event.location)}` : ''}` : '';
}
/** What Ica says when a parcel moves. */
export function parcelMessage(parcel: Parcel, state: ParcelState, first: boolean) {
  const name = `<b>${escapeHtml(parcel.label)}</b>`;
  const status = STATUS_LABEL[state.status ?? ''] ?? 'Update';
  const headline = first ? `📦 Now tracking ${name}${state.carrierName ? ` with ${escapeHtml(state.carrierName)}` : ''}: ${status.toLowerCase()}.`
    : state.status === 'Delivered' ? `📦 ${name} was delivered ✓`
    : `📦 ${name}: ${status.toLowerCase()}.`;
  // Carriers often repeat the status as the event ("Out for delivery"): then only the place adds anything.
  const restated = state.latest?.text.trim().toLowerCase() === status.toLowerCase();
  const latest = restated ? escapeHtml(state.latest?.location ?? '') : eventLine(state.latest);
  return ['Doot Doot.', headline, latest, `<a href="${trackingPage(parcel.number)}">Details</a>`].filter(Boolean).join('\n');
}

function nextState(previous: ParcelState | undefined, info: TrackInfo, now: number): ParcelState {
  const next: ParcelState = {
    registered: true, status: info.status, carrierName: info.carrierName, carrierKey: info.carrierKey,
    latest: info.latest, events: info.events, eta: info.eta, checkedAt: now, changedAt: previous?.changedAt, registerAttemptAt: previous?.registerAttemptAt,
  };
  if (key(previous) !== key(next)) next.changedAt = now;
  return next;
}

export interface ParcelDeps {
  owners: Record<string, string>;
  store: ParcelStore;
  send(chatId: string, text: string): Promise<void>;
  /** Null when TRACK17_API_KEY isn't set. */
  track: Track17 | null;
  now?: () => number;
  log?: (line: string) => void;
}

export async function runParcels(deps: ParcelDeps) {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => {});
  let registered = 0, checked = 0, announced = 0;
  for (const [uid, chatId] of Object.entries(deps.owners)) {
    const [parcels, states] = await Promise.all([deps.store.parcels(uid), deps.store.parcelStates(uid)]);
    const active = parcels.filter(parcel => !parcel.archived);
    if (!active.length) continue;
    const save = async (parcel: Parcel, state: ParcelState) => { states.set(parcel.id, state); await deps.store.saveParcelState(uid, parcel.id, clean(state)); };

    if (!deps.track) {
      for (const parcel of active) if (states.get(parcel.id)?.error !== NOT_CONFIGURED && !states.get(parcel.id)?.registered)
        await save(parcel, { registered: false, error: NOT_CONFIGURED, checkedAt: now() });
      continue;
    }

    // Register new numbers (and retry refused ones now and then).
    const fresh = active.filter(parcel => {
      const state = states.get(parcel.id);
      return !state?.registered && (!state?.registerAttemptAt || now() - state.registerAttemptAt >= RETRY_REGISTER_MS);
    });
    for (const batch of chunks(fresh)) {
      const result = await deps.track.register(batch.map(parcel => ({ number: parcel.number, carrier: parcel.carrier || undefined })));
      for (const parcel of batch) {
        const previous = states.get(parcel.id);
        const rejection = result.rejected.find(r => r.number === parcel.number);
        if (result.registered.has(parcel.number)) { registered++; await save(parcel, { ...previous, registered: true, error: undefined, registerAttemptAt: now(), checkedAt: 0 }); }
        else await save(parcel, { ...previous, registered: false, error: explainRejection(rejection ?? { message: '' }), registerAttemptAt: now(), checkedAt: now() });
      }
    }

    // Read the latest status of whatever is due.
    const due = active.filter(parcel => {
      const state = states.get(parcel.id);
      return state?.registered && now() - (state.checkedAt ?? 0) >= pollEvery(state.status);
    });
    for (const batch of chunks(due)) {
      const { infos } = await deps.track.info(batch.map(parcel => ({ number: parcel.number, carrier: states.get(parcel.id)?.carrierKey || parcel.carrier || undefined })));
      const byNumber = new Map(infos.map(info => [info.number, info]));
      for (const parcel of batch) {
        const info = byNumber.get(parcel.number);
        const previous = states.get(parcel.id);
        if (!info) { await save(parcel, { ...previous!, checkedAt: now() }); continue; }
        checked++;
        const next = nextState(previous, info, now());
        const moved = key(previous) !== key(next) && !!(next.status || next.latest);
        // "Waiting for the carrier" with nothing to show isn't news.
        const worthSaying = moved && !(next.status === 'NotFound' && !next.latest);
        if (worthSaying) {
          try { await deps.send(chatId, parcelMessage(parcel, next, !previous?.status && !previous?.latest)); announced++; }
          catch { next.changedAt = previous?.changedAt; next.status = previous?.status; next.latest = previous?.latest; } // say it next run
        }
        await save(parcel, next);
      }
    }
  }
  log(`parcels: ${registered} registered, ${checked} checked, ${announced} announced`);
  return { registered, checked, announced };
}

/** Lines for the morning briefing: what needs you, and what's due today. */
export function briefingParcels(parcels: Parcel[], states: Map<string, ParcelState>, today: string) {
  return parcels.filter(parcel => !parcel.archived).flatMap(parcel => {
    const state = states.get(parcel.id);
    if (!state?.status) return [];
    const dueToday = !!state.eta?.to && state.eta.to.slice(0, 10) <= today && state.status !== 'Delivered';
    if (!URGENT.has(state.status) && !dueToday) return [];
    return [`${escapeHtml(parcel.label)}: ${URGENT.has(state.status) ? STATUS_LABEL[state.status].toLowerCase() : 'due today'}`];
  });
}

/** /parcels: everything still being tracked. */
export function parcelsReply(parcels: Parcel[], states: Map<string, ParcelState>) {
  const active = parcels.filter(parcel => !parcel.archived);
  if (!active.length) return 'Doot Doot.\nNo parcels yet. Send “track <number> <name>”, or add one in Voracity.';
  return ['Doot Doot.', ...active.map(parcel => {
    const state = states.get(parcel.id);
    const status = state?.error ?? (state?.status ? STATUS_LABEL[state.status] : state?.registered ? 'Registered, waiting for the carrier' : 'Not tracked yet');
    return `• <b>${escapeHtml(parcel.label)}</b>: ${escapeHtml(status)}${state?.latest ? ` (${eventLine(state.latest)})` : ''}`;
  })].join('\n');
}

/** A parcel document exactly as Voracity creates one. */
export function parcelFor(p: { number: string; label: string }, now: number): Parcel {
  return { id: crypto.randomUUID(), number: p.number, label: p.label, carrier: 0, archived: false, createdAt: now, updatedAt: now, revision: 0 };
}
