import { describe, expect, it } from 'vitest';
import { decodeHtml, retryAfterMs } from '../src/fetch.ts';
import { diffItems, extractItems, summarise } from '../src/extract.ts';
import { baselineMessage, changeMessage, escapeHtml } from '../src/telegram.ts';

// Synthetic markup shaped like a card shop listing (not copied from any site).
const card = (code: string, name: string, price: string, stock: number) => `
  <div class="card-product"><div class="starbtn"><img alt="Star" src="s.svg"></div>
    <a href="/card/${code}"><img alt="${code} ${name}" src="c.jpg"></a>
    <span class="code">${code}</span><a href="/card/${code}"><h4>${name}</h4></a>
    <strong>${price} 円</strong><label>在庫 : ${stock} 点</label>
    <a class="btn" href="javascript:;">-</a><input class="stock" value="0"><a class="btn">+</a>
    <a class="btn main-btn" href="javascript:;">カートへ</a></div>`;
const page = (cards: string) => `<html><head><title>x</title><script>var t = Date.now()</script></head><body>
  <nav>Menu</nav><section id="pickup"><p>Rotating pick</p></section><div id="list">${cards}</div></body></html>`;

describe('extraction', () => {
  it('turns each matching element into one readable item without controls', () => {
    const items = extractItems(page(card('EX13-001', 'Agumon', '980', 3) + card('EX13-002', 'Gabumon', '1,200', 0)), '.card-product');
    expect(items).toEqual(['EX13-001 Agumon 980 円 在庫 : 3 点', 'EX13-002 Gabumon 1,200 円 在庫 : 0 点']);
  });
  it('applies the ignore pattern before comparing, and finds nothing when the list is empty', () => {
    expect(extractItems(page(card('EX13-001', 'Agumon', '980', 3)), '.card-product', '在庫\\s*:\\s*\\d+\\s*点')).toEqual(['EX13-001 Agumon 980 円']);
    expect(extractItems(page('<p>検索条件に該当する商品は見つかりませんでした。</p>'), '.card-product')).toEqual([]);
  });
  it('falls back to visible page lines without scripts', () => {
    const lines = extractItems(page('<p>Hello <b>world</b></p><p>Second</p>'), '');
    expect(lines).toContain('Hello world');
    expect(lines).toContain('Second');
    expect(lines.join(' ')).not.toContain('Date.now');
  });
  it('reports invalid selectors and patterns clearly', () => {
    expect(() => extractItems(page(''), 'div[')).toThrow('CSS selector');
    expect(() => extractItems(page(''), 'div', '(')).toThrow('ignore pattern');
  });
  it('decodes Shift_JIS pages from their meta charset', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<meta charset="shift_jis"><p>'), 0x83, 0x65, 0x83, 0x58, 0x83, 0x67, ...new TextEncoder().encode('</p>')]);
    expect(decodeHtml(bytes, 'text/html')).toContain('テスト');
  });
  it('parses Retry-After in seconds and as a date', () => {
    expect(retryAfterMs('120')).toBe(120_000);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT'))).toBe(60_000);
    expect(retryAfterMs('soon')).toBeUndefined();
  });
});

describe('diff', () => {
  it('pairs entries with the same leading code as changes', () => {
    const before = ['EX13-001 Agumon 980 円', 'EX13-002 Gabumon 1,200 円', 'EX13-003 Patamon 500 円'];
    const after = ['EX13-001 Agumon 880 円', 'EX13-002 Gabumon 1,200 円', 'EX13-004 Tentomon 300 円'];
    const diff = diffItems(before, after);
    expect(diff).toEqual({ added: ['EX13-004 Tentomon 300 円'], removed: ['EX13-003 Patamon 500 円'], changed: [{ before: 'EX13-001 Agumon 980 円', after: 'EX13-001 Agumon 880 円' }] });
    expect(summarise(diff)).toBe('1 new, 1 changed, 1 gone');
  });
  it('does not pair plain text lines without codes', () => {
    expect(diffItems(['Open today'], ['Closed today']).changed).toEqual([]);
  });
});

describe('Telegram messages', () => {
  it('start with Doot Doot., escape HTML and stay within Telegram limits', () => {
    const diff = { added: Array.from({ length: 40 }, (_, i) => `EX13-${String(i).padStart(3, '0')} <b>Card</b> & co ${'x'.repeat(250)}`), removed: [], changed: [] };
    const text = changeMessage('EX13 <singles>', 'https://shop.example/a?b=1&c="2"', diff);
    expect(text.startsWith('Doot Doot.\n')).toBe(true);
    expect(text).toContain('&lt;singles&gt;');
    expect(text).toContain('&lt;b&gt;Card&lt;/b&gt; &amp; co');
    expect(text).toContain('…and 30 more');
    expect(text).toContain('href="https://shop.example/a?b=1&amp;c=&quot;2&quot;"');
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(baselineMessage('EX13', 'https://x.example', 0, '.card-product')).toContain('0 items match <code>.card-product</code>');
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });
});
