import { expect, test } from 'vitest';
import { callbackFor, parseDecision, proposalsFor, PROPOSAL_TTL_MS, validateAction, type Action, type Decision } from '../src/confirmations.ts';
import { memoryConfirmations } from './confirmation-memory.ts';
import type { NewBookmark, NewCard } from '../src/listen.ts';
import type { CardDoc } from '../src/edit.ts';

const now = 1_800_000_000_000;
const action: Action = { kind: 'note', title: 'Synthetic note', body: 'Synthetic body' };
function setup(existing: CardDoc[] = []) {
  const cards: NewCard[] = [], bookmarks: NewBookmark[] = [];
  const memory = memoryConfirmations(cards, bookmarks, [], existing);
  async function offer(actions = [action], together = false) {
    const entries = proposalsFor('owner', actions, now, together);
    await memory.store.offerProposals('owner', entries, now);
    return Object.entries(entries).map(([id, p]) => parseDecision(callbackFor('save', id, p))!);
  }
  const decide = (d: Decision, at = now) => memory.store.decideProposal('owner', d, at, false);
  return { ...memory, cards, bookmarks, offer, decide };
}
test('replay returns the original result, with one create and a compact receipt', async () => {
  const f = setup(), [d] = await f.offer();
  const first = await f.decide(d);
  expect(first.status).toBe('saved');
  expect(await f.decide(d)).toEqual(first);
  expect(f.cards).toHaveLength(1);
  expect(f.cards[0].body).toBe('Synthetic body');
  expect(JSON.stringify(f.state().receipts)).not.toContain('Synthetic body');
  expect(f.state().pending).toEqual({});
});
test('failed commit leaves both proposal and target unchanged; retry succeeds once', async () => {
  const f = setup(), [d] = await f.offer();
  f.failCommit();
  await expect(f.decide(d)).rejects.toThrow('Synthetic commit failure');
  expect(f.cards).toHaveLength(0);
  expect(f.state().pending[d.id]).toBeDefined();
  expect(f.state().receipts).toEqual({});
  expect((await f.decide(d)).status).toBe('saved');
  expect(f.cards).toHaveLength(1);
});
test('concurrent confirmation and cancellation select one terminal result', async () => {
  const f = setup(), [d] = await f.offer();
  const results = await Promise.all([f.decide({ ...d, action: 'cancel' }), f.decide(d)]);
  expect(results.map(r => r.status)).toEqual(['cancelled', 'cancelled']);
  expect(f.cards).toHaveLength(0);
});
test('expiry, legacy records, forged fields, owner and argument mismatch cannot write', async () => {
  const f = setup(), [d] = await f.offer();
  expect((await f.store.decideProposal('other', d, now, false)).status).toBe('expired');
  expect((await f.decide({ ...d, digest: '0'.repeat(16) })).status).toBe('invalid');
  f.state().pending[d.id].action = { ...action, title: 'Changed after display' };
  expect((await f.decide(d)).status).toBe('expired');
  expect(f.cards).toHaveLength(0);
  const g = setup(), [expired] = await g.offer();
  expect((await g.decide(expired, now + PROPOSAL_TTL_MS)).status).toBe('expired');
  expect(g.cards).toHaveLength(0);
  expect(parseDecision('delete:' + d.id + ':' + d.digest)).toBeNull();
  expect(parseDecision('save:' + d.id)).toBeNull();
  expect(() => validateAction({ kind: 'reminder', title: 'Test', body: '', dueDate: '2026-02-30' })).toThrow();
  expect(() => validateAction({ ...action, body: {}, extra: true })).toThrow();
});
test('one confirmed group choice consumes siblings without trusting callback ids', async () => {
  const f = setup(), [a, b] = await f.offer([action, { ...action, title: 'Other' }], true);
  expect((await f.decide(a)).status).toBe('saved');
  expect((await f.decide(b)).status).toBe('cancelled');
  expect(f.cards).toHaveLength(1);
  expect(Buffer.byteLength(`save:${a.id}:${a.digest}`)).toBeLessThanOrEqual(64);
});
test('transactional offering does not resurrect consumed proposals or discard another offer', async () => {
  const f = setup(), [a] = await f.offer();
  const original = structuredClone(f.state().pending);
  const [b] = await f.offer([{ kind: 'bookmark', title: 'Reading', url: 'https://example.com/' }]);
  await f.decide(a);
  expect(f.state().pending[b.id]).toBeDefined();
  await expect(f.store.offerProposals('owner', original, now)).rejects.toThrow('reused');
  await f.decide(b);
  expect(f.bookmarks).toHaveLength(1);
});

test('expired receipt eviction cannot replay a consumed action; receipts remain bounded', async () => {
  const f = setup();
  let first: Decision | undefined;
  for (let i = 0; i < 70; i++) {
    const [d] = await f.offer();
    first ??= d;
    await f.decide(d);
  }
  expect(Object.keys(f.state().receipts)).toHaveLength(64);
  expect((await f.decide(first!)).status).toBe('expired');
  expect(f.cards).toHaveLength(70);
});

test('full proposal storage refuses an offer without dropping accepted work', async () => {
  const f = setup();
  for (let i = 0; i < 32; i++) await f.offer();
  await expect(f.offer()).rejects.toThrow('storage is full');
  expect(Object.keys(f.state().pending)).toHaveLength(32);
});
