import { expect, it } from 'vitest';
import { answerQuestion, type AgentContext } from '../src/agent.ts';
import { localModel } from '../src/local-model.ts';

// Explicit opt-in only. Synthetic context, no credentials, production DB or Telegram.
it.skipIf(process.env.WATCHER_LIVE_OLLAMA !== 'true')('live local model proposes a synthetic note without performing a write', async () => {
  const result = await answerQuestion('Use propose_note to offer a note titled "Harness synthetic check" with body "Synthetic test only". Then ask me to confirm it.', {
    uid: 'synthetic-live', today: '2026-10-05', timeZone: 'Asia/Singapore', calendars: [], ollama: localModel(),
    store: { cards: async () => [], unreadBookmarks: async () => [], watches: async () => [], states: async () => new Map() } as unknown as AgentContext['store'],
  });
  expect(result.status).toBe('complete');
  expect(result.proposals).toContainEqual({ kind: 'note', title: 'Harness synthetic check', body: 'Synthetic test only' });
  expect(result.answer).toContain('confirm');
}, 190000);
