import { SetupError, owners, safeError, secret, serviceAccount } from './config.ts';
import { firestoreStore } from './firestore.ts';
import { listen } from './listen.ts';

// The local runner: 5-minute schedule plus Telegram commands, until stopped.
try {
  const token = secret('TELEGRAM_BOT_TOKEN');
  if (!token) throw new SetupError('TELEGRAM_BOT_TOKEN is not set');
  await listen({ token, owners: owners(), store: firestoreStore(serviceAccount()), base: {}, log: line => console.log(line) });
} catch (error) {
  console.error(`Watcher listener failed: ${safeError(error)}`);
  process.exitCode = 1;
}
