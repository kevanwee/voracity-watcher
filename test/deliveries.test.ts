import { expect, it } from 'vitest';
import { DELIVERY_TTL_MS, deliveryIdentity, findOffer, type OfferedDelivery } from '../src/deliveries.ts';
import { callbackFor, parseDecision, proposalsFor } from '../src/confirmations.ts';
import { memoryConfirmations } from './confirmation-memory.ts';
import type { NewCard } from '../src/listen.ts';

const now = 1_800_000_000_000, uid = 'synthetic';
const identity = deliveryIdentity({ update_id: 12, message: { date: now / 1000, chat: { id: 42 }, text: 'note: hello' } });
function offer(at = now): OfferedDelivery {
  return { identity, at, date: '2027-01-15', together: false, answer: 'Synthetic answer',
    entries: proposalsFor(uid, [{ kind: 'note', title: 'Synthetic note', body: 'Body' }], at, false) };
}
it('concurrent redeliveries return the same original proposals and answer', async () => {
  const f = memoryConfirmations([], [], [], []);
  const first = offer(), second = offer(); second.answer = 'Different inference';
  const [a, b] = await Promise.all([f.store.rememberOffer(uid, first, now), f.store.rememberOffer(uid, second, now)]);
  expect(a).toEqual(first); expect(b).toEqual(first);
  expect(f.state().pending).toEqual(first.entries);
});
it('a crash after confirming cannot reinsert the consumed proposal on capture replay', async () => {
  const cards: NewCard[] = [], f = memoryConfirmations(cards, [], [], []);
  const original = await f.store.rememberOffer(uid, offer(), now);
  const [id, p] = Object.entries(original.entries)[0], d = parseDecision(callbackFor('save', id, p))!;
  await f.store.decideProposal(uid, d, now, false);
  expect(await f.store.rememberOffer(uid, offer(now + 1), now + 1)).toEqual(original);
  await f.store.decideProposal(uid, d, now + 1, false);
  expect(cards).toHaveLength(1); expect(f.state().pending).toEqual({});
});
it('failed commits leave both the ledger and proposals unchanged', async () => {
  const f = memoryConfirmations([], [], [], []); f.failCommit();
  await expect(f.store.rememberOffer(uid, offer(), now)).rejects.toThrow('commit');
  expect(f.state().pending).toEqual({}); expect(await f.store.offered(uid, identity, now)).toBeNull();
  await f.store.rememberOffer(uid, offer(), now);
  expect(Object.keys(f.state().pending)).toHaveLength(1);
});
it('rejects changed payloads under the same delivery ID and bounds the replay window', async () => {
  const f = memoryConfirmations([], [], [], []); const original = offer();
  await f.store.rememberOffer(uid, original, now);
  await expect(f.store.offered(uid, { ...identity, fingerprint: 'a'.repeat(64) }, now)).rejects.toThrow('conflict');
  expect(findOffer({ [identity.id]: original }, identity, now + DELIVERY_TTL_MS)).toBeNull();
  expect(() => deliveryIdentity({ update_id: -1 })).toThrow();
});
it('does not record delivery acceptance if the H1 inbox is full', async () => {
  const f = memoryConfirmations([], [], [], []);
  for (let i = 0; i < 4; i++) await f.store.offerProposals(uid, proposalsFor(uid,
    Array.from({ length: 8 }, () => ({ kind: 'note', title: 'Synthetic', body: '' })), now, false), now);
  await expect(f.store.rememberOffer(uid, offer(), now)).rejects.toThrow('full');
  expect(await f.store.offered(uid, identity, now)).toBeNull();
  expect(Object.keys(f.state().pending)).toHaveLength(32);
});
