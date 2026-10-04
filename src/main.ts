import { runAssistant } from './assistant.ts';
import { eventsBetween, fetchCalendars, formatEvent } from './calendar.ts';
import { SetupError, calendars, owners, safeError, secret, serviceAccount } from './config.ts';
import { firestoreStore } from './firestore.ts';
import { drainOnce } from './listen.ts';
import { briefingParcels, runParcels } from './parcels.ts';
import { runOnce } from './run.ts';
import { track17 } from './track17.ts';
import { ownerTranslator } from './translate.ts';
import { sendTelegram } from './telegram.ts';

/** The PC listener counts as away when it hasn't checked in for this long. */
const PC_AWAY_MS = 10 * 60_000;

// One scheduled run (GitHub Actions, or run.ps1 locally). Logs are counts only.
try {
  const token = secret('TELEGRAM_BOT_TOKEN');
  if (!token) throw new SetupError('TELEGRAM_BOT_TOKEN is not set');
  const runner = process.env.WATCHER_RUNNER === 'local' ? 'local' : 'cloud';
  const ownerMap = owners();
  const store = firestoreStore(serviceAccount());
  const send = (chatId: string, text: string, buttons?: { text: string; data: string }[][]) => sendTelegram(token, chatId, text, undefined, buttons);
  const feeds = calendars();
  const log = (line: string) => console.log(line);
  // On the PC, Japanese names in alerts are translated by the local model; the cloud has none.
  await runOnce({ owners: ownerMap, store, send, test: process.env.WATCHER_TEST === 'true', runner, log, translate: runner === 'local' ? ownerTranslator(store) : undefined });
  if (runner === 'cloud') {
    // Parcels first, so the briefing has their latest status. A 17TRACK outage doesn't stop the run.
    const trackKey = secret('TRACK17_API_KEY');
    await runParcels({ owners: ownerMap, store, send, track: trackKey ? track17(trackKey) : null, log }).catch(() => log('parcels: check failed'));
    // Briefings and reminder alerts run in the cloud: always on, Firestore only.
    await runAssistant({ owners: ownerMap, store, send, log, events: async (uid, today, timeZone) => {
      if (!feeds[uid]) return [];
      const { texts } = await fetchCalendars(feeds[uid]);
      return eventsBetween(texts, today, today, timeZone).map(formatEvent);
    }, parcels: async (uid, today) => {
      const [parcels, states] = await Promise.all([store.parcels(uid), store.parcelStates(uid)]);
      return briefingParcels(parcels, states, today);
    } });
    // While the PC listener is away, answer waiting Telegram messages here instead.
    const statuses = await Promise.all(Object.keys(ownerMap).map(uid => store.status(uid)));
    const pcAway = statuses.every(status => !status?.localRunAt || Date.now() - status.localRunAt > PC_AWAY_MS);
    if (pcAway) { await drainOnce({ token, owners: ownerMap, store, base: { log }, log, calendars: feeds }); log('messages: handled in the cloud'); }
  }
} catch (error) {
  console.error(`Watcher run failed: ${safeError(error)}`);
  process.exitCode = 1;
}
