import { decideTransaction, offerTransaction, type ConfirmationStore, type ConfirmationTransaction, type Inbox } from '../src/confirmations.ts';
import type { CardDoc } from '../src/edit.ts';
import type { NewBookmark, NewCard } from '../src/listen.ts';
import type { Parcel } from '../src/parcels.ts';

/** Transactional test adapter. Real contention/atomicity is tested on Firestore too. */
export function memoryConfirmations(cards: NewCard[], bookmarks: NewBookmark[], parcels: Parcel[], existing: CardDoc[]) {
  let inbox: Inbox = { pending: {}, receipts: {} };
  let fail = false;
  let tail: Promise<unknown> = Promise.resolve();
  const atomic = <T>(fn: (tx: ConfirmationTransaction) => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      const writes: (() => void)[] = [];
      const result = await fn({
        inbox: async () => structuredClone(inbox),
        card: async id => structuredClone(existing.find(c => c.id === id)),
        parcels: async () => structuredClone(parcels),
        create: (collection, id, data) => {
          const target = collection === 'cards' ? cards : collection === 'bookmarks' ? bookmarks : parcels;
          if (target.some(d => d.id === id)) throw new Error('Already exists');
          writes.push(() => (target as object[]).push(structuredClone(data)));
        },
        updateCard: (id, patch) => { writes.push(() => Object.assign(existing.find(c => c.id === id)!, patch)); },
        deleteCard: id => { writes.push(() => { existing.splice(existing.findIndex(c => c.id === id), 1); }); },
        saveInbox: next => { writes.push(() => { inbox = structuredClone(next); }); },
      });
      if (fail) { fail = false; throw new Error('Synthetic commit failure'); }
      writes.forEach(w => w());
      return result;
    });
    tail = run.catch(() => {});
    return run;
  };
  const store: ConfirmationStore = {
    offerProposals: (uid, entries, now) => atomic(tx => offerTransaction(tx, uid, entries, now)),
    decideProposal: (uid, decision, now, parcelsEnabled) => atomic(tx => decideTransaction(tx, uid, decision, now, parcelsEnabled)),
  };
  return { store, state: () => inbox, failCommit: () => { fail = true; }, seed: (value: Inbox) => { inbox = value; } };
}
