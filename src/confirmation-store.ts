import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { decideTransaction, offerTransaction, type ConfirmationStore, type ConfirmationTransaction } from './confirmations.ts';
import type { CardDoc } from './edit.ts';

export function confirmationStore(db: Firestore): ConfirmationStore {
  function adapter(tx: Transaction, uid: string): ConfirmationTransaction {
    if (!uid || uid.includes('/')) throw new Error('Invalid owner.');
    const owner = db.collection('users').doc(uid);
    const inbox = owner.collection('assistant').doc('inbox');
    const cards = owner.collection('cards');
    return {
      inbox: async () => (await tx.get(inbox)).data(),
      card: async id => (await tx.get(cards.doc(id))).data() as CardDoc | undefined,
      parcels: async () => (await tx.get(owner.collection('parcels'))).docs.map(d => d.data() as { number: string; archived: boolean }),
      create: (collection, id, data) => { tx.create(owner.collection(collection).doc(id), data); },
      updateCard: (id, patch) => { tx.update(cards.doc(id), patch); },
      deleteCard: id => { tx.delete(cards.doc(id)); },
      saveInbox: value => { tx.set(inbox, value); },
    };
  }
  return {
    offerProposals: (uid, entries, now) => db.runTransaction(tx => offerTransaction(adapter(tx, uid), uid, entries, now)),
    decideProposal: (uid, decision, now, parcelsEnabled) => db.runTransaction(tx => decideTransaction(adapter(tx, uid), uid, decision, now, parcelsEnabled)),
  };
}
