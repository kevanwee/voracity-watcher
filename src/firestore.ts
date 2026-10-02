import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { AssistantSettings, AssistantStore, Bookmark, Reminder, Schedule } from './assistant.ts';
import { VERSION } from './fetch.ts';
import type { CaptureStore, NewBookmark, NewCard, Pending } from './listen.ts';
import type { ItemsDoc, Store, Watch, WatchState } from './run.ts';

export interface RunnerStatus { lastRunAt?: number; cloudRunAt?: number; localRunAt?: number }
export type FullStore = Store & AssistantStore & CaptureStore & { status(uid: string): Promise<RunnerStatus | null> };

/**
 * Reads users/{uid}/watches, cards, bookmarks and settings/assistant; writes the
 * runner-only documents: watchState/{id}, watchItems/{id}, watcher/status and
 * assistant/{schedule,inbox}. Creates cards and bookmarks only after the owner taps Save.
 */
export function firestoreStore(serviceAccountJson: string | undefined): FullStore {
  const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const app = emulator
    ? initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-voracity' })
    : initializeApp({ credential: cert(JSON.parse(serviceAccountJson ?? 'null')) });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const user = (uid: string) => db.collection('users').doc(uid);
  const assistant = (uid: string, name: 'schedule' | 'inbox') => user(uid).collection('assistant').doc(name);
  return {
    async watches(uid) {
      const snap = await user(uid).collection('watches').get();
      return snap.docs.map(doc => ({ ...doc.data(), id: doc.id }) as Watch)
        .filter(watch => typeof watch.url === 'string' && typeof watch.interval === 'number')
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    async states(uid) {
      const snap = await user(uid).collection('watchState').get();
      return new Map(snap.docs.map(doc => [doc.id, doc.data() as WatchState]));
    },
    async items(uid) {
      const snap = await user(uid).collection('watchItems').get();
      return new Map(snap.docs.map(doc => [doc.id, doc.data() as ItemsDoc]));
    },
    async save(uid, id, state, items) {
      const batch = db.batch();
      batch.set(user(uid).collection('watchState').doc(id), state);
      if (items) batch.set(user(uid).collection('watchItems').doc(id), items);
      await batch.commit();
    },
    async removeItems(uid, id) {
      await user(uid).collection('watchItems').doc(id).delete();
    },
    async heartbeat(uid, at, runner) {
      // Merge, so the cloud and local runners keep separate heartbeats.
      await user(uid).collection('watcher').doc('status').set({ lastRunAt: at, version: VERSION, [`${runner}RunAt`]: at }, { merge: true });
    },
    async status(uid) {
      const snap = await user(uid).collection('watcher').doc('status').get();
      return snap.exists ? (snap.data() as RunnerStatus) : null;
    },
    async settings(uid) {
      const snap = await user(uid).collection('settings').doc('assistant').get();
      return snap.exists ? (snap.data() as Partial<AssistantSettings>) : null;
    },
    async schedule(uid) {
      const snap = await assistant(uid, 'schedule').get();
      return (snap.data() as Schedule | undefined) ?? {};
    },
    async saveSchedule(uid, schedule) {
      await assistant(uid, 'schedule').set(schedule);
    },
    async openReminders(uid, dueDate) {
      // Equality filters only, so no composite index is needed; reads scale with matches.
      let query = user(uid).collection('cards').where('kind', '==', 'reminder').where('done', '==', false);
      if (dueDate) query = query.where('dueDate', '==', dueDate);
      const snap = await query.get();
      return snap.docs.map(doc => doc.data() as Reminder).filter(r => typeof r.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.dueDate ?? ''));
    },
    async unreadBookmarks(uid) {
      const snap = await user(uid).collection('bookmarks').where('status', '==', 'unread').get();
      return snap.docs.map(doc => doc.data() as Bookmark);
    },
    async inbox(uid) {
      const snap = await assistant(uid, 'inbox').get();
      return ((snap.data() as { pending?: Record<string, Pending> } | undefined)?.pending) ?? {};
    },
    async saveInbox(uid, pending) {
      await assistant(uid, 'inbox').set({ pending });
    },
    async createCard(uid, card: NewCard) {
      await user(uid).collection('cards').doc(card.id).create(card);
    },
    async createBookmark(uid, bookmark: NewBookmark) {
      await user(uid).collection('bookmarks').doc(bookmark.id).create(bookmark);
    },
  };
}
