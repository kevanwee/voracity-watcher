// Changing existing cards from Telegram. Every change is a proposal the owner confirms,
// and every write is checked against the card's revision, as Voracity's own editor does,
// so a newer edit made elsewhere is never overwritten.
import { extractDue, formatDue } from './capture.ts';
import { GREETING, escapeHtml } from './telegram.ts';

export interface CardDoc {
  id: string; kind: 'link' | 'note' | 'reminder'; title: string; body: string; url: string; dueDate: string;
  done: boolean; pinned: boolean; tone: string; createdAt: number; updatedAt: number; revision: number;
  position?: number; driveAccount?: string;
}

export type Change =
  | { kind: 'complete'; cardId: string; title: string; revision: number }
  | { kind: 'update'; cardId: string; title: string; revision: number; changes: { title?: string; dueDate?: string } }
  | { kind: 'delete'; cardId: string; title: string; revision: number; cardKind: CardDoc['kind'] };

export type WriteResult = 'ok' | 'missing' | 'conflict';

export interface EditStore {
  cards(uid: string): Promise<CardDoc[]>;
  /** Transaction: applies `patch` only if the card still has `revision`; bumps revision and updatedAt. */
  updateCard(uid: string, id: string, revision: number, patch: Partial<Pick<CardDoc, 'title' | 'dueDate' | 'done'>>, now: number): Promise<WriteResult>;
  deleteCard(uid: string, id: string, revision: number): Promise<WriteResult>;
}

export const isChange = (value: { kind: string }): value is Change => ['complete', 'update', 'delete'].includes(value.kind);

export type EditCommand =
  | { name: 'done'; query: string }
  | { name: 'delete'; query: string }
  | { name: 'move'; query: string; when: string };

/** "/done brief", "/delete old note", "/move brief to Monday" (also "/due brief Monday"). */
export function parseEdit(text: string): EditCommand | null {
  const m = text.trim().match(/^\/(done|delete|move|due)(?:@\w+)?\s+([\s\S]+)$/i);
  if (!m) return null;
  const name = m[1].toLowerCase(), rest = m[2].trim();
  if (name === 'done') return { name: 'done', query: rest };
  if (name === 'delete') return { name: 'delete', query: rest };
  const to = rest.match(/^(.+?)\s+to\s+(.+)$/i);
  if (to) return { name: 'move', query: to[1].trim(), when: to[2].trim() };
  return { name: 'move', query: rest, when: '' };
}

const words = (value: string) => value.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Best title matches: exact, then prefix, then contains, then shared words. At most `limit`. */
export function matchCards(cards: CardDoc[], query: string, limit = 3) {
  const q = query.toLowerCase().trim(), qWords = words(query);
  if (!q) return [];
  const scored = cards.map(card => {
    const title = card.title.toLowerCase();
    let score = title === q ? 100 : title.startsWith(q) ? 80 : title.includes(q) ? 60 : 0;
    if (!score && qWords.length) {
      const t = new Set(words(card.title));
      const shared = qWords.filter(w => t.has(w)).length;
      if (shared) score = 20 + (40 * shared) / qWords.length;
    }
    return { card, score };
  }).filter(x => x.score >= 40);
  scored.sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt);
  const best = scored[0]?.score;
  // An exact match wins outright; otherwise offer the close candidates.
  return (best === 100 ? scored.filter(x => x.score === 100) : scored).slice(0, limit).map(x => x.card);
}

/** Turn an edit command into proposals, or a message explaining why not. */
export function planEdit(command: EditCommand, cards: CardDoc[], today: string): { changes: Change[]; error?: string } {
  if (command.name === 'done') {
    const open = cards.filter(c => c.kind === 'reminder' && !c.done);
    const found = matchCards(open, command.query);
    if (!found.length) return { changes: [], error: `No open reminder matches “${command.query}”.` };
    return { changes: found.map(c => ({ kind: 'complete', cardId: c.id, title: c.title, revision: c.revision })) };
  }
  if (command.name === 'delete') {
    const found = matchCards(cards, command.query);
    if (!found.length) return { changes: [], error: `Nothing in My Space matches “${command.query}”.` };
    return { changes: found.map(c => ({ kind: 'delete', cardId: c.id, title: c.title, revision: c.revision, cardKind: c.kind })) };
  }
  const { dueDate } = extractDue(command.when || command.query, today);
  const query = command.when ? command.query : extractDue(command.query, today).rest;
  if (!dueDate) return { changes: [], error: 'Which day? Try “/move file the brief to Monday”.' };
  const found = matchCards(cards.filter(c => c.kind === 'reminder'), query);
  if (!found.length) return { changes: [], error: `No reminder matches “${query}”.` };
  return { changes: found.map(c => ({ kind: 'update', cardId: c.id, title: c.title, revision: c.revision, changes: { dueDate } })) };
}

export function changeQuestion(changes: Change[], today: string) {
  const first = changes[0];
  const verb = first.kind === 'complete' ? 'Mark this done?' : first.kind === 'delete' ? 'Delete this?' : `Move this to ${formatDue((first as Extract<Change, { kind: 'update' }>).changes.dueDate ?? '', today)}?`;
  if (changes.length === 1) {
    const extra = first.kind === 'update' && first.changes.title ? `\nNew title: <b>${escapeHtml(first.changes.title)}</b>` : '';
    return `${GREETING}\n${verb}\n<b>${escapeHtml(first.title)}</b>${extra}`;
  }
  return `${GREETING}\n${verb.replace('this', 'which one')} I found ${changes.length}:`;
}

export function changeButtonLabel(change: Change) {
  const icon = change.kind === 'complete' ? '✓' : change.kind === 'delete' ? '🗑' : '📅';
  const title = change.title.length > 28 ? change.title.slice(0, 27) + '…' : change.title;
  return `${icon} ${title}`;
}

export function changeResultText(change: Change, result: WriteResult, today: string) {
  if (result === 'missing') return `${GREETING}\n<b>${escapeHtml(change.title)}</b> no longer exists.`;
  if (result === 'conflict') return `${GREETING}\n<b>${escapeHtml(change.title)}</b> was changed somewhere else since I asked, so I left it alone. Send the request again if you still want it.`;
  if (change.kind === 'complete') return `${GREETING}\nDone ✓ <b>${escapeHtml(change.title)}</b> (moved to Archive)`;
  if (change.kind === 'delete') return `${GREETING}\nDeleted <b>${escapeHtml(change.title)}</b>.`;
  const parts = [change.changes.title ? `now “${escapeHtml(change.changes.title)}”` : '', change.changes.dueDate !== undefined ? `due ${formatDue(change.changes.dueDate, today)}` : ''].filter(Boolean);
  return `${GREETING}\nUpdated ✓ <b>${escapeHtml(change.title)}</b>, ${parts.join(', ')}`;
}

/** Apply a confirmed change with revision protection. */
export async function applyChange(store: EditStore, uid: string, change: Change, now: number): Promise<WriteResult> {
  if (change.kind === 'delete') return store.deleteCard(uid, change.cardId, change.revision);
  if (change.kind === 'complete') return store.updateCard(uid, change.cardId, change.revision, { done: true }, now);
  return store.updateCard(uid, change.cardId, change.revision, change.changes, now);
}
