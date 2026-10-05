import { SetupError } from './config.ts';

export interface LocalModel { url: string; model: string }
export const DEFAULT_OLLAMA: Readonly<LocalModel> = { url: 'http://localhost:11434', model: 'qwen3:14b' };
export function validateLocalModel(value: LocalModel): LocalModel {
  let url: URL;
  try { url = new URL(value.url); } catch { throw new SetupError('The local model URL is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new SetupError('The model URL must be a loopback origin without credentials, path or query.');
  if (typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value.model)) throw new SetupError('The local model name is invalid.');
  return { url: url.origin, model: value.model };
}
/** The Windows launcher fills unset environment fields from its local config. */
export function localModel(env: NodeJS.ProcessEnv = process.env): LocalModel {
  return validateLocalModel({ url: env.WATCHER_OLLAMA_URL ?? DEFAULT_OLLAMA.url, model: env.WATCHER_OLLAMA_MODEL ?? DEFAULT_OLLAMA.model });
}
/** Compatibility helper for old callers; new execution uses strict validation. */
export function localOllamaUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    if (url.username || url.password) return DEFAULT_OLLAMA.url;
    return validateLocalModel({ url: url.origin, model: DEFAULT_OLLAMA.model }).url;
  } catch { return DEFAULT_OLLAMA.url; }
}
