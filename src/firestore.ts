import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { VERSION } from './fetch.ts';
import type { ItemsDoc, Store, Watch, WatchState } from './run.ts';

/**
 * Reads users/{uid}/watches and writes the runner-only documents:
 * watchState/{id} (shown in Voracity), watchItems/{id} (snapshots) and watcher/status.
 */
export function firestoreStore(serviceAccountJson: string | undefined): Store {
  const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
  const app = emulator
    ? initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-voracity' })
    : initializeApp({ credential: cert(JSON.parse(serviceAccountJson ?? 'null')) });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  const user = (uid: string) => db.collection('users').doc(uid);
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
  };
}
