import { describe, expect, it } from 'vitest';
import { CACHE_SIZE, ollamaTranslator, ownerTranslator, readTranslations, trimCache } from '../src/translate.ts';

describe('translating listing names on the PC', () => {
  it('keeps only clean answers to what was asked', () => {
    const asked = ['アルファモン(パラレル)', 'オメガモン'];
    expect(readTranslations('<think>hmm</think>```json\n{"アルファモン(パラレル)": "Alphamon (Parallel)", "オメガモン": "<b>Omnimon</b>", "extra": "x"}\n```', asked))
      .toEqual({ 'アルファモン(パラレル)': 'Alphamon (Parallel)', 'オメガモン': 'bOmnimon/b' });
    expect(readTranslations('not json', asked)).toEqual({});
    expect(readTranslations('["Alphamon"]', asked)).toEqual({});
    expect(readTranslations('{"オメガモン": "オメガモン"}', asked)).toEqual({}); // unchanged isn't a translation
  });

  it("asks the owner's local model, with thinking off and JSON out", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      const names: string[] = JSON.parse(body.messages[1].content);
      return new Response(JSON.stringify({ message: { content: JSON.stringify(Object.fromEntries(names.map(n => [n, `EN ${n.length}`]))) } }));
    }) as typeof fetch;
    const model = { url: 'http://127.0.0.1:11434', model: 'qwen3:14b' };
    const names = Array.from({ length: 35 }, (_, i) => `カード${i}`);
    const out = await ownerTranslator(fetcher, model)('uid', names);
    expect(Object.keys(out)).toHaveLength(35);
    expect(calls).toHaveLength(2); // batches of 30
    expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0].body).toMatchObject({ model: 'qwen3:14b', stream: false, think: false, format: 'json', options: { temperature: 0 } });
    expect(calls[0].body.messages[0].content).toContain('official English card or character name');
    expect(() => ownerTranslator(fetcher, { url: 'https://example.com', model: 'm' })).toThrow('loopback');
    await expect(ollamaTranslator({ url: 'http://localhost:11434', model: 'm' }, (async () => new Response('', { status: 500 })) as typeof fetch)(['テスト'])).rejects.toThrow('HTTP 500');
  });

  it('keeps the names in use when the cache is full', () => {
    const cache = Object.fromEntries(Array.from({ length: CACHE_SIZE + 50 }, (_, i) => [`n${i}`, `e${i}`]));
    const trimmed = trimCache(cache, new Set(['n0', 'n1']));
    expect(Object.keys(trimmed)).toHaveLength(CACHE_SIZE);
    expect(trimmed.n0).toBe('e0');
    expect(trimmed[`n${CACHE_SIZE + 49}`]).toBe(`e${CACHE_SIZE + 49}`); // newest kept
  });
});

describe('the glossary', () => {
  it('translates known names exactly without the model, and tidies spacing', async () => {
    const { fromGlossary, tidyName } = await import('../src/glossary.ts');
    expect(fromGlossary('アルファモン(パラレル)')).toBe('Alphamon (Parallel)');
    expect(fromGlossary('デュナスモン(パラレル/特別仕様)')).toBe('Dynasmon (Parallel/Special Edition)');
    expect(fromGlossary('ガンクゥモン（パラレル）')).toBe('Gankoomon (Parallel)');
    expect(fromGlossary('デューテモン(パラレル)')).toBeNull(); // not certain: left to the model
    expect(tidyName('Omnimon(Parallel)')).toBe('Omnimon (Parallel)');
    let called = 0;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      called++;
      const names: string[] = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(names).toEqual(['デューテモン(パラレル)']);
      return new Response(JSON.stringify({ message: { content: '{"デューテモン(パラレル)": "Duetmon(Parallel)"}' } }));
    }) as typeof fetch;
    const out = await ollamaTranslator({ url: 'http://localhost:11434', model: 'm' }, fetcher)(['アルファモン(パラレル)', 'デューテモン(パラレル)']);
    expect(out).toEqual({ 'アルファモン(パラレル)': 'Alphamon (Parallel)', 'デューテモン(パラレル)': 'Duetmon (Parallel)' });
    expect(called).toBe(1);
  });
});
