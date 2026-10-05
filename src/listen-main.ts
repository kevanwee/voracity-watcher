import { SetupError, calendars, owners, relay, safeError, secret, serviceAccount } from './config.ts';
import { firestoreStore } from './firestore.ts';
import { localModel } from './local-model.ts';
import { listen } from './listen.ts';

// The local runner: 5-minute schedule plus Telegram commands, until stopped.
try {
  const token = secret('TELEGRAM_BOT_TOKEN');
  if (!token) throw new SetupError('TELEGRAM_BOT_TOKEN is not set');
  const log = (line: string) => console.log(line);
  const ollama = localModel();
  log(`Local AI: ${ollama.model} at ${ollama.url}`);
  await listen({ ollama, token, owners: owners(), store: firestoreStore(serviceAccount()), base: { log }, log, calendars: calendars(), relay: relay() });
} catch (error) {
  console.error(`Watcher listener failed: ${safeError(error)}`);
  process.exitCode = 1;
}
