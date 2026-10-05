// English names for Japanese listings, written by the owner's local Ollama model on the PC
// (the same PC-local configuration as Ica's questions). Nothing
// goes to a cloud service; without the model, alerts keep the original names.
import { localModel, validateLocalModel, type LocalModel } from './local-model.ts';
import { fromGlossary, glossaryHints, tidyName } from './glossary.ts';

export type Translate = (uid: string, names: string[]) => Promise<Record<string, string>>;
/** Names per model call, and how long one call may take. */
const BATCH = 30;
const TIMEOUT_MS = 90_000;
/** Translations remembered per watch, so each name is translated once. */
export const CACHE_SIZE = 400;

const SYSTEM = `You translate Japanese trading-card shop listings into English for the owner.
Reply with only a JSON object that maps each original string, exactly as given, to its English name.
- Use the official English card or character name when you know it (Digimon: オメガモン → Omnimon, アルファモン → Alphamon, デュナスモン → Dynasmon, ジエスモン → Jesmon; Pokémon: ピカチュウ → Pikachu).
- Translate edition and rarity notes in brackets: パラレル → Parallel, 特別仕様 → Special Edition, 箔押し → Foil Stamped, プロモ → Promo.
- Keep codes, numbers and Latin letters as they are. Keep it short: no explanations.
Known names (use exactly): ${glossaryHints()}.`;

/** Accept only a clean name for each name we asked about. */
export function readTranslations(content: string, asked: string[]) {
  let parsed: unknown;
  try { parsed = JSON.parse(content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?|```$/gm, '').trim()); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const wanted = new Set(asked), out: Record<string, string> = {};
  for (const [original, english] of Object.entries(parsed as Record<string, unknown>)) {
    if (!wanted.has(original) || typeof english !== 'string') continue;
    const value = tidyName(english.replace(/[<>]/g, ''));
    if (value && value.length <= 120 && value !== original) out[original] = value;
  }
  return out;
}

export function ollamaTranslator(ollama: { url: string; model: string }, fetcher: typeof fetch = fetch) {
  const model = validateLocalModel(ollama);
  return async (names: string[]) => {
    const out: Record<string, string> = {};
    // Names the glossary covers are exact and instant; only the rest go to the model.
    const rest: string[] = [];
    for (const name of names) { const known = fromGlossary(name); if (known) out[name] = known; else rest.push(name); }
    for (let i = 0; i < rest.length; i += BATCH) {
      const batch = rest.slice(i, i + BATCH);
      const response = await fetcher(`${model.url}/api/chat`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ model: model.model, stream: false, think: false, format: 'json', options: { temperature: 0, num_ctx: 8192 },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(batch) }] }),
      });
      if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
      const body = await response.json() as { message?: { content?: string } };
      Object.assign(out, readTranslations(body.message?.content ?? '', batch));
    }
    return out;
  };
}

/** Questions and translation use the same explicit configuration on this PC. */
export function ownerTranslator(fetcher?: typeof fetch, model: LocalModel = localModel()): Translate {
  const translate = ollamaTranslator(model, fetcher);
  return async (_uid, names) => translate(names);
}

/** Keep the names in use now, then the most recently added, up to CACHE_SIZE. */
export function trimCache(cache: Record<string, string>, inUse: Set<string>) {
  const entries = Object.entries(cache);
  if (entries.length <= CACHE_SIZE) return cache;
  const keep = [...entries.filter(([k]) => inUse.has(k)), ...entries.filter(([k]) => !inUse.has(k)).reverse()].slice(0, CACHE_SIZE);
  return Object.fromEntries(keep);
}
