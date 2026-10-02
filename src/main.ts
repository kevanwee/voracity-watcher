import { SetupError, owners, safeError, secret, serviceAccount } from './config.ts';
import { firestoreStore } from './firestore.ts';
import { runOnce } from './run.ts';
import { sendTelegram } from './telegram.ts';

// One scheduled check (GitHub Actions, or run.ps1 locally). Logs are counts only.
try {
  const token = secret('TELEGRAM_BOT_TOKEN');
  if (!token) throw new SetupError('TELEGRAM_BOT_TOKEN is not set');
  await runOnce({
    owners: owners(),
    store: firestoreStore(serviceAccount()),
    send: (chatId, text) => sendTelegram(token, chatId, text),
    test: process.env.WATCHER_TEST === 'true',
    runner: process.env.WATCHER_RUNNER === 'local' ? 'local' : 'cloud',
    log: line => console.log(line),
  });
} catch (error) {
  console.error(`Watcher run failed: ${safeError(error)}`);
  process.exitCode = 1;
}
