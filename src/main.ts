import { firestoreStore } from './firestore.ts';
import { runOnce } from './run.ts';
import { sendTelegram } from './telegram.ts';

// Actions logs on a public repository are public. Never print secrets, owner
// IDs, watched addresses or page content: only fixed messages and counts.
class SetupError extends Error {}

/** Secrets pasted through Windows PowerShell 5.1 can arrive with a byte-order mark or a trailing newline. */
const secret = (name: string) => process.env[name]?.replace(/^\uFEFF/, '').trim() || undefined;

function owners(): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(secret('WATCHER_OWNERS') ?? ''); } catch { throw new SetupError('WATCHER_OWNERS must be JSON like {"<notes UID>": "<Telegram chat ID>"}'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SetupError('WATCHER_OWNERS must be a JSON object');
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([uid, chat]) => /^[A-Za-z0-9_-]{1,128}$/.test(uid) && /^-?\d{1,20}$/.test(String(chat)));
  if (!entries.length) throw new SetupError('WATCHER_OWNERS has no valid owner entries');
  return Object.fromEntries(entries.map(([uid, chat]) => [uid, String(chat)]));
}

function serviceAccount() {
  if (process.env.FIRESTORE_EMULATOR_HOST) return undefined;
  const raw = secret('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) throw new SetupError('FIREBASE_SERVICE_ACCOUNT is not set');
  try { JSON.parse(raw); } catch { throw new SetupError('FIREBASE_SERVICE_ACCOUNT is not valid JSON; paste the whole key file'); }
  return raw;
}

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
  const code = error instanceof SetupError ? error.message
    : (error as { code?: unknown })?.code !== undefined ? `error code ${String((error as { code: unknown }).code).slice(0, 40)}`
    : (error as Error)?.name ?? 'unknown error';
  console.error(`Watcher run failed: ${code}`);
  process.exitCode = 1;
}
