export const LIMITS_AGENT = {
  rounds: 4, tools: 8, deadlineMs: 180_000, questionChars: 4000,
  requestBytes: 24_000, inputBytes: 72_000, responseBytes: 64_000,
  resultBytes: 6000, storedCards: 2000, outputTokens: 1024,
} as const;
export type StopReason = 'deadline' | 'cancelled' | 'input_limit' | 'tool_limit' | 'round_limit'
  | 'output_limit' | 'invalid_response' | 'invalid_input' | 'invalid_result' | 'lookup_failed' | 'model_unavailable';
export class AgentStop extends Error {
  reason: StopReason;
  constructor(reason: StopReason) { super(reason); this.reason = reason; }
}
export const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** One deadline covers initial reads, every model call and every tool lookup. */
export function agentBudget(now: () => number, external?: AbortSignal) {
  const deadline = now() + LIMITS_AGENT.deadlineMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AgentStop('deadline')), LIMITS_AGENT.deadlineMs);
  const cancel = () => controller.abort(new AgentStop('cancelled'));
  external?.addEventListener('abort', cancel, { once: true });
  if (external?.aborted) cancel();
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (now() >= deadline) { controller.abort(new AgentStop('deadline')); throw controller.signal.reason; }
  };
  async function wait<T>(job: () => Promise<T>): Promise<T> {
    check();
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    try { const result = await Promise.race([Promise.resolve().then(() => { check(); return job(); }), stopped]); check(); return result; }
    finally { controller.signal.removeEventListener('abort', abort); }
  }
  return { signal: controller.signal, check, wait, close: () => { clearTimeout(timer); external?.removeEventListener('abort', cancel); } };
}

/** Bound response bytes while reading, including missing/false Content-Length. */
export async function boundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) { void response.body?.cancel().catch(() => {}); throw new AgentStop('output_limit'); }
  const reader = response.body?.getReader();
  if (!reader) throw new AgentStop('invalid_response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { cancel(); throw new AgentStop('output_limit'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Preserve valid JSON and explicitly report coverage when a result is too large. */
export function toolResult(value: unknown): string {
  const valid = (v: unknown, depth = 0): boolean => depth < 8 && (v === null || typeof v === 'string' || typeof v === 'boolean'
    || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every(x => valid(x, depth + 1)))
    || (plainObject(v) && Object.values(v).every(x => valid(x, depth + 1))));
  if (!valid(value)) throw new AgentStop('invalid_result');
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) <= LIMITS_AGENT.resultBytes) return text;
  if (!Array.isArray(value)) return JSON.stringify({ error: 'result_too_large', truncated: true });
  const items: unknown[] = [];
  for (const item of value) {
    const next = { items: [...items, item], total: value.length, shown: items.length + 1, truncated: true };
    if (Buffer.byteLength(JSON.stringify(next)) > LIMITS_AGENT.resultBytes) break;
    items.push(item);
  }
  return JSON.stringify({ items, total: value.length, shown: items.length, truncated: true });
}
