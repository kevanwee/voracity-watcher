// Runtime-independent confirmation policy. The storage adapter MUST run each
// callback in one atomic transaction, including the inbox and the target object.
import { createHash, randomUUID } from 'node:crypto';
import { LIMITS, safeUrl, type Proposal } from './capture.ts';
import type { CardDoc, Change, WriteResult } from './edit.ts';
import { parcelFor } from './parcels.ts';

export const PROPOSAL_TTL_MS = 86_400_000;
const RECEIPT_TTL_MS = 7 * PROPOSAL_TTL_MS;
export type Action = Proposal | Change;
export interface Pending { version: 1; action: Action; createdAt: number; group: string[]; digest: string }
export interface Outcome {
  status: 'saved' | 'cancelled' | 'expired' | 'invalid' | 'missing' | 'conflict' | 'duplicate' | 'disabled';
  proposal?: Action;
  targetId?: string;
}
interface Receipt { version: 1; digest: string; at: number; outcome: Outcome }
export interface Inbox { pending: Record<string, Pending>; receipts: Record<string, Receipt> }
export interface Decision { action: 'save' | 'cancel'; id: string; digest: string }
export interface ConfirmationStore {
  offerProposals(uid: string, entries: Record<string, Pending>, now: number): Promise<void>;
  decideProposal(uid: string, decision: Decision, now: number, parcelsEnabled: boolean): Promise<Outcome>;
}
export interface ConfirmationTransaction {
  inbox(): Promise<unknown>;
  card(id: string): Promise<CardDoc | undefined>;
  parcels(): Promise<{ number: string; archived: boolean }[]>;
  create(collection: 'cards' | 'bookmarks' | 'parcels', id: string, data: object): void;
  updateCard(id: string, patch: object): void;
  deleteCard(id: string): void;
  saveInbox(inbox: Inbox): void;
}
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
const PROPOSAL_ID = /^[a-f0-9]{10}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown, max: number, empty = false): v is string => typeof v === 'string' && v.length <= max && (empty || !!v.trim());
export const realDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

/** Closed schemas also protect Admin SDK writes, which bypass client rules. */
export function validateAction(value: unknown): Action {
  if (!record(value)) throw new Error('Invalid proposal.');
  const v = value;
  const fields: Record<string, string[]> = {
    note: ['kind', 'title', 'body'], reminder: ['kind', 'title', 'body', 'dueDate'],
    bookmark: ['kind', 'title', 'url'], parcel: ['kind', 'number', 'label'],
    complete: ['kind', 'cardId', 'title', 'revision'],
    delete: ['kind', 'cardId', 'title', 'revision', 'cardKind'],
    update: ['kind', 'cardId', 'title', 'revision', 'changes'],
  };
  const keys = typeof v.kind === 'string' && Object.hasOwn(fields, v.kind) ? fields[v.kind] : undefined;
  if (!keys || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error('Invalid proposal fields.');
  if (v.kind === 'parcel') {
    if (!text(v.label, 60) || typeof v.number !== 'string' || !/^[A-Z0-9-]{6,40}$/.test(v.number) || !/\d/.test(v.number)) throw new Error('Invalid parcel.');
  } else {
    if (!text(v.title, v.kind === 'bookmark' ? 200 : 120)) throw new Error('Invalid title.');
    if (v.kind === 'note' || v.kind === 'reminder') {
      if (!text(v.body, LIMITS.body, true) || (v.kind === 'reminder' && v.dueDate !== '' && !realDate(v.dueDate))) throw new Error('Invalid note or reminder.');
    } else if (v.kind === 'bookmark') {
      if (!text(v.url, LIMITS.url) || !safeUrl(v.url)) throw new Error('Invalid bookmark URL.');
    } else {
      if (typeof v.cardId !== 'string' || !ID.test(v.cardId) || !integer(v.revision)) throw new Error('Invalid target.');
      if (v.kind === 'delete' && !['note', 'link', 'reminder'].includes(String(v.cardKind))) throw new Error('Invalid target kind.');
      if (v.kind === 'update') {
        const p = v.changes;
        if (!record(p) || !Object.keys(p).length || Object.keys(p).some(k => !['title', 'dueDate'].includes(k))
          || ('title' in p && !text(p.title, 120)) || ('dueDate' in p && p.dueDate !== '' && !realDate(p.dueDate))) throw new Error('Invalid change.');
      }
    }
  }
  return structuredClone(value) as Action;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(uid: string, id: string, p: Omit<Pending, 'digest'>) {
  return createHash('sha256').update(canonical({ uid, id, ...p })).digest('hex');
}
export function proposalsFor(uid: string, actions: Action[], now: number, together: boolean): Record<string, Pending> {
  if (!integer(now) || !actions.length || actions.length > 8) throw new Error('Invalid proposal batch.');
  const ids = actions.map(() => randomUUID().replaceAll('-', '').slice(0, 10));
  return Object.fromEntries(actions.map((a, i) => {
    const p = { version: 1 as const, action: validateAction(a), createdAt: now, group: together ? ids : [ids[i]] };
    return [ids[i], { ...p, digest: digest(uid, ids[i], p) }];
  }));
}
export function callbackFor(action: Decision['action'], id: string, p: Pending) {
  return `${action}:${id}:${p.digest.slice(0, 16)}`;
}
export function parseDecision(data: string): Decision | null {
  const match = /^(save|cancel):([a-f0-9]{10}):([a-f0-9]{16})$/.exec(data);
  return match ? { action: match[1] as Decision['action'], id: match[2], digest: match[3] } : null;
}
function validPending(uid: string, id: string, value: unknown): value is Pending {
  if (!PROPOSAL_ID.test(id) || !record(value) || value.version !== 1 || !integer(value.createdAt)
    || !Array.isArray(value.group) || value.group.length < 1 || value.group.length > 8
    || value.group.some(k => typeof k !== 'string' || !PROPOSAL_ID.test(k)) || !value.group.includes(id)) return false;
  try {
    const p = { version: 1 as const, action: validateAction(value.action), createdAt: value.createdAt, group: value.group as string[] };
    return value.digest === digest(uid, id, p);
  } catch { return false; }
}
function readInbox(value: unknown): Inbox {
  const v = record(value) ? value : {};
  return { pending: record(v.pending) ? structuredClone(v.pending) as Inbox['pending'] : {}, receipts: record(v.receipts) ? structuredClone(v.receipts) as Inbox['receipts'] : {} };
}
function prune(inbox: Inbox, now: number) {
  // Legacy proposals have no argument binding and are deliberately expired.
  inbox.pending = Object.fromEntries(Object.entries(inbox.pending).filter(([, p]) => record(p) && p.version === 1 && integer(p.createdAt) && p.createdAt <= now && now - p.createdAt < PROPOSAL_TTL_MS));
  inbox.receipts = Object.fromEntries(Object.entries(inbox.receipts).reverse().filter(([, r]) => r?.version === 1 && integer(r.at) && now - r.at < RECEIPT_TTL_MS)
    .sort((a, b) => b[1].at - a[1].at).slice(0, 64));
}
function persist(tx: ConfirmationTransaction, inbox: Inbox) {
  if (Object.keys(inbox.pending).length > 32 || Buffer.byteLength(JSON.stringify(inbox), 'utf8') > 700_000) throw new Error('Proposal storage is full. Handle pending proposals before trying again.');
  tx.saveInbox(inbox);
}
export async function offerTransaction(tx: ConfirmationTransaction, uid: string, entries: Record<string, Pending>, now: number) {
  const inbox = readInbox(await tx.inbox());
  prune(inbox, now);
  for (const [id, p] of Object.entries(entries)) {
    if (!validPending(uid, id, p) || p.createdAt > now || now - p.createdAt >= PROPOSAL_TTL_MS || Object.hasOwn(inbox.pending, id) || Object.hasOwn(inbox.receipts, id)) throw new Error('Invalid or reused proposal.');
    inbox.pending[id] = p;
  }
  persist(tx, inbox);
}
export function cardFor(p: Extract<Proposal, { kind: 'reminder' | 'note' }>, now: number, id: string = randomUUID()) {
  return { id, kind: p.kind, title: p.title, body: p.body, url: '', dueDate: p.kind === 'reminder' ? p.dueDate : '',
    done: false, pinned: false, tone: 'cream', createdAt: now, updatedAt: now, revision: 0 };
}
export function bookmarkFor(p: Extract<Proposal, { kind: 'bookmark' }>, now: number, id: string = randomUUID()) {
  return { id, url: p.url, title: p.title, snippet: '', tags: [] as string[], status: 'unread', createdAt: now, updatedAt: now, revision: 0 };
}
export async function decideTransaction(tx: ConfirmationTransaction, uid: string, decision: Decision, now: number, parcelsEnabled: boolean): Promise<Outcome> {
  if (!integer(now) || !parseDecision(`${decision.action}:${decision.id}:${decision.digest}`)) return { status: 'invalid' };
  const inbox = readInbox(await tx.inbox());
  const old = inbox.receipts[decision.id];
  if (old?.version === 1 && typeof old.digest === 'string' && old.digest.slice(0, 16) === decision.digest && integer(old.at) && now >= old.at && now - old.at < RECEIPT_TTL_MS) return old.outcome;
  const p = inbox.pending[decision.id];
  if (!p || !validPending(uid, decision.id, p)) return { status: 'expired' };
  if (p.digest.slice(0, 16) !== decision.digest) return { status: 'invalid' };
  const a = p.action;
  let outcome: Outcome = { status: 'saved', proposal: a };
  let write: (() => void) | undefined;
  if (p.createdAt > now || now - p.createdAt >= PROPOSAL_TTL_MS) outcome = { status: 'expired' };
  else if (decision.action === 'cancel') outcome = { status: 'cancelled' };
  else if (a.kind === 'complete' || a.kind === 'update' || a.kind === 'delete') {
    const card = await tx.card(a.cardId);
    const result: WriteResult = !card ? 'missing' : card.revision !== a.revision ? 'conflict' : 'ok';
    if (result !== 'ok') outcome.status = result;
    else if ((a.kind === 'complete' || (a.kind === 'update' && 'dueDate' in a.changes)) && card!.kind !== 'reminder'
      || (a.kind === 'delete' && card!.kind !== a.cardKind)) outcome.status = 'invalid';
    else {
      outcome.targetId = a.cardId;
      write = a.kind === 'delete' ? () => tx.deleteCard(a.cardId)
        : () => tx.updateCard(a.cardId, { ...(a.kind === 'complete' ? { done: true } : a.changes), updatedAt: now, revision: a.revision + 1 });
    }
  } else {
    const id = 'ica_' + createHash('sha256').update(uid + ':' + decision.id + ':' + p.digest).digest('hex').slice(0, 40);
    outcome.targetId = id;
    if (a.kind === 'parcel') {
      if (!parcelsEnabled) outcome.status = 'disabled';
      else if ((await tx.parcels()).some(x => x.number === a.number && !x.archived)) outcome.status = 'duplicate';
      else write = () => tx.create('parcels', id, { ...parcelFor(a, now), id });
    } else write = () => tx.create(a.kind === 'bookmark' ? 'bookmarks' : 'cards', id,
      a.kind === 'bookmark' ? bookmarkFor(a, now, id) : cardFor(a, now, id));
  }
  // Group membership is stored/bound, never supplied by the callback.
  for (const id of p.group) {
    const sibling = inbox.pending[id];
    if (sibling && validPending(uid, id, sibling) && canonical(sibling.group) === canonical(p.group)) {
      delete inbox.pending[id];
      inbox.receipts[id] = { version: 1, digest: sibling.digest, at: now, outcome: id === decision.id ? outcome : { status: 'cancelled' } };
    }
  }
  // Receipts need titles/dates for retry responses, never captured note bodies.
  if (outcome.proposal && (outcome.proposal.kind === 'note' || outcome.proposal.kind === 'reminder')) {
    outcome = { ...outcome, proposal: { ...outcome.proposal, body: '' } };
    inbox.receipts[decision.id].outcome = outcome;
  }
  prune(inbox, now);
  persist(tx, inbox);
  write?.(); // All reads and validation precede writes; adapter commits atomically.
  return outcome;
}
