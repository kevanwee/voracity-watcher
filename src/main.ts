import { runAssistant } from './assistant.ts';
import { eventsBetween, fetchCalendars, formatEvent } from './calendar.ts';
import { SetupError, calendars, owners, safeError, secret, serviceAccount } from './config.ts';
import { firestoreStore } from './firestore.ts';
import { drainOnce } from './listen.ts';
import { runOnce } from './run.ts';
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
  await runOnce({ owners: ownerMap, store, send, test: process.env.WATCHER_TEST === 'true', runner, log });
  if (runner === 'cloud') {
    // Briefings and reminder alerts run in the cloud: always on, Firestore only.
    await runAssistant({ owners: ownerMap, store, send, log, events: async (uid, today, timeZone) => {
      if (!feeds[uid]) return [];
      const { texts } = await fetchCalendars(feeds[uid]);
      return eventsBetween(texts, today, today, timeZone).map(formatEvent);
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
