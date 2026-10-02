// Secrets and settings shared by the cloud entry point (main.ts) and the local
// listener (listen-main.ts). Actions logs on a public repository are public, so
// errors here are fixed text: never secrets, owner IDs or addresses.
export class SetupError extends Error {}

/** Secrets pasted through Windows PowerShell 5.1 can arrive with a byte-order mark or a trailing newline. */
export const secret = (name: string) => process.env[name]?.replace(/^\uFEFF/, '').trim() || undefined;

export function owners(): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(secret('WATCHER_OWNERS') ?? ''); } catch { throw new SetupError('WATCHER_OWNERS must be JSON like {"<notes UID>": "<Telegram chat ID>"}'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SetupError('WATCHER_OWNERS must be a JSON object');
  const entries = Object.entries(parsed as Record<string, unknown>).filter(([uid, chat]) => /^[A-Za-z0-9_-]{1,128}$/.test(uid) && /^-?\d{1,20}$/.test(String(chat)));
  if (!entries.length) throw new SetupError('WATCHER_OWNERS has no valid owner entries');
  return Object.fromEntries(entries.map(([uid, chat]) => [uid, String(chat)]));
}

export function serviceAccount() {
  if (process.env.FIRESTORE_EMULATOR_HOST) return undefined;
  const raw = secret('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) throw new SetupError('FIREBASE_SERVICE_ACCOUNT is not set');
  try { JSON.parse(raw); } catch { throw new SetupError('FIREBASE_SERVICE_ACCOUNT is not valid JSON; paste the whole key file'); }
  return raw;
}


/** Fixed-text description of a failure that is safe to print. */
export function safeError(error: unknown) {
  return error instanceof SetupError ? error.message
    : (error as { code?: unknown })?.code !== undefined ? `error code ${String((error as { code: unknown }).code).slice(0, 40)}`
    : (error as Error)?.name ?? 'unknown error';
}
