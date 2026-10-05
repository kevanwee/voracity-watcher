import { afterAll, beforeAll, expect, test } from 'vitest';
import { initializeApp, deleteApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { confirmationStore } from '../src/confirmation-store.ts';
import { callbackFor, parseDecision, proposalsFor, type Action } from '../src/confirmations.ts';

// No credential fallback: this suite cannot reach production.
const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
const projectId = 'demo-ica-confirmations';
let app: App, db: Firestore;
beforeAll(() => {
  if (!enabled) return;
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST!)) throw new Error('Use a loopback emulator.');
  app = initializeApp({ projectId }, 'confirmations-' + crypto.randomUUID());
  db = getFirestore(app);
});
afterAll(async () => { if (app) await deleteApp(app); });
const now = 1_800_000_000_000;
const note: Action = { kind: 'note', title: 'Synthetic note', body: 'Synthetic body' };
async function fixture(actions: Action[] = [note], together = false) {
  const uid = 'synthetic-' + crypto.randomUUID();
  const owner = db.collection('users').doc(uid);
  const store = confirmationStore(db);
  const entries = proposalsFor(uid, actions, now, together);
  await store.offerProposals(uid, entries, now);
  const decisions = Object.entries(entries).map(([id, p]) => parseDecision(callbackFor('save', id, p))!);
  return { uid, owner, store, decisions, entries, decide: (d = decisions[0]) => store.decideProposal(uid, d, now, false) };
}
test.skipIf(!enabled)('Firestore: concurrent callbacks produce one target and the same outcome', async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 4 }, () => f.decide()));
  expect(results.every(r => r.status === 'saved' && r.targetId === results[0].targetId)).toBe(true);
  expect((await f.owner.collection('cards').get()).size).toBe(1);
  expect((await f.owner.collection('assistant').doc('inbox').get()).get('pending')).toEqual({});
  // Simulate losing the commit response / Telegram notification and retry later.
  expect(await f.decide()).toEqual(results[0]);
  expect((await f.owner.collection('cards').get()).size).toBe(1);
}, 30000);
test.skipIf(!enabled)('Firestore: competing offers and confirmation retain unrelated pending work', async () => {
  const f = await fixture();
  const extra = proposalsFor(f.uid, [{ kind: 'bookmark', title: 'Synthetic reading', url: 'https://example.com/' }], now, false);
  await Promise.all([f.decide(), f.store.offerProposals(f.uid, extra, now)]);
  const inbox = (await f.owner.collection('assistant').doc('inbox').get()).data()!;
  expect(Object.keys(inbox.pending)).toEqual(Object.keys(extra));
  const [id, p] = Object.entries(extra)[0];
  const d = parseDecision(callbackFor('save', id, p))!;
  await Promise.all([f.decide(d), f.decide(d)]);
  expect((await f.owner.collection('bookmarks').get()).size).toBe(1);
}, 30000);
test.skipIf(!enabled)('Firestore: a failed target create rolls back proposal consumption and receipt', async () => {
  const f = await fixture();
  const first = await f.decide();
  // Restore the proposal to simulate an inconsistent legacy recovery, while the
  // deterministic target already exists. create() must fail the entire transaction.
  await f.owner.collection('assistant').doc('inbox').set({ pending: f.entries, receipts: {} });
  await expect(f.decide()).rejects.toThrow();
  const inbox = (await f.owner.collection('assistant').doc('inbox').get()).data()!;
  expect(inbox.pending).toEqual(f.entries);
  expect(inbox.receipts).toEqual({});
  expect((await f.owner.collection('cards').doc(first.targetId!).get()).exists).toBe(true);
}, 30000);
test.skipIf(!enabled)('Firestore: revisions, groups and cancellation apply atomically', async () => {
  const change: Action = { kind: 'update', cardId: 'card1', title: 'Synthetic reminder', revision: 2, changes: { dueDate: '2026-10-06' } };
  const f = await fixture([change]);
  await f.owner.collection('cards').doc('card1').set({ id: 'card1', kind: 'reminder', revision: 3, dueDate: '2026-10-07' });
  expect((await f.decide()).status).toBe('conflict');
  expect((await f.owner.collection('cards').doc('card1').get()).get('dueDate')).toBe('2026-10-07');
  const g = await fixture([note, { ...note, title: 'Other synthetic note' }], true);
  const results = await Promise.all(g.decisions.map(d => g.decide(d)));
  expect(results.map(r => r.status).sort()).toEqual(['cancelled', 'saved']);
  expect((await g.owner.collection('cards').get()).size).toBe(1);
  const h = await fixture();
  await h.decide({ ...h.decisions[0], action: 'cancel' });
  expect((await h.decide()).status).toBe('cancelled');
  expect((await h.owner.collection('cards').get()).size).toBe(0);
}, 30000);
