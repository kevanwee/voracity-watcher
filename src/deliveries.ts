// A bounded replay ledger for incoming Telegram captures. Its write and the H1
// proposal insertion MUST commit in the same transaction.
import { createHash } from 'node:crypto';
import { offerTransaction, type ConfirmationTransaction, type Pending } from './confirmations.ts';
import type { Update } from './listen.ts';

export const DELIVERY_TTL_MS = 7 * 86_400_000;
export interface DeliveryIdentity { id: string; fingerprint: string }
export interface OfferedDelivery {
  identity: DeliveryIdentity;
  at: number;
  entries: Record<string, Pending>;
  date: string;
  together: boolean;
  answer?: string;
}
export type DeliveryLedger = Record<string, OfferedDelivery>;
export interface DeliveryStore {
  offered(uid: string, identity: DeliveryIdentity, now: number): Promise<OfferedDelivery | null>;
  rememberOffer(uid: string, offer: OfferedDelivery, now: number): Promise<OfferedDelivery>;
}
export interface DeliveryTransaction extends ConfirmationTransaction {
  deliveries(): Promise<DeliveryLedger>;
  saveDeliveries(ledger: DeliveryLedger): void;
}
export function deliveryIdentity(update: Update): DeliveryIdentity {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new Error('Invalid delivery ID.');
  // Only the supported message fields participate; Telegram's extra metadata is irrelevant.
  const m = update.message;
  return { id: `tg_${update.update_id}`, fingerprint: createHash('sha256')
    .update(JSON.stringify([update.update_id, m?.chat.id, m?.date, m?.text ?? ''])).digest('hex') };
}
export function findOffer(ledger: DeliveryLedger, identity: DeliveryIdentity, now: number): OfferedDelivery | null {
  if (!/^tg_\d{1,16}$/.test(identity.id) || !/^[a-f0-9]{64}$/.test(identity.fingerprint)) throw new Error('Invalid delivery identity.');
  const old = ledger[identity.id];
  if (!old || now - old.at >= DELIVERY_TTL_MS) return null;
  if (old.at > now || old.identity.fingerprint !== identity.fingerprint) throw new Error('Delivery identity conflict.');
  return old;
}
export async function rememberOfferTransaction(tx: DeliveryTransaction, uid: string, offer: OfferedDelivery, now: number) {
  const ledger = await tx.deliveries();
  const old = findOffer(ledger, offer.identity, now);
  if (old) return old; // Includes proposals already confirmed, cancelled or expired.
  if (offer.at !== now || !Number.isSafeInteger(now) || now < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(offer.date)
    || (offer.answer !== undefined && (typeof offer.answer !== 'string' || offer.answer.length > 20000))
    || typeof offer.together !== 'boolean' || !Object.keys(offer.entries).length || Object.keys(offer.entries).length > 8) throw new Error('Invalid offer.');
  const next = Object.fromEntries(Object.entries(ledger).filter(([, d]) => d.at <= now && now - d.at < DELIVERY_TTL_MS));
  next[offer.identity.id] = offer;
  // Refuse new work rather than evicting an unexpired retry identity.
  if (Object.keys(next).length > 128 || Buffer.byteLength(JSON.stringify(next), 'utf8') > 700_000) throw new Error('Delivery storage is full.');
  await offerTransaction(tx, uid, offer.entries, now);
  tx.saveDeliveries(next);
  return offer;
}
