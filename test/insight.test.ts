import { describe, expect, it } from 'vitest';
import { classify, headline, namesIn, needsTranslation, parseListing } from '../src/insight.ts';
import { changeMessage } from '../src/telegram.ts';

const pair = (before: string, after: string) => ({ before, after });

describe('reading shop listings', () => {
  it('reads yuyu-tei lines: code, name, yen price and stock (× is sold out)', () => {
    expect(parseListing('EX13-060 アルファモン(パラレル) 2,480 円 在庫 : 1 点')).toMatchObject({ code: 'EX13-060', name: 'アルファモン(パラレル)', price: { amount: 2480, currency: '¥' }, stock: 1 });
    expect(parseListing('EX13-037 デュナスモン(パラレル/特別仕様) 6,980 円 在庫 : ×')).toMatchObject({ name: 'デュナスモン(パラレル/特別仕様)', price: { amount: 6980 }, stock: 0 });
  });

  it('reads English shops too, and leaves unknown lines alone', () => {
    expect(parseListing('BT26-050 Omnimon $12.99 Sold out')).toMatchObject({ code: 'BT26-050', name: 'Omnimon', price: { amount: 12.99, currency: '$' }, stock: 0 });
    expect(parseListing('Booster box S$189.00 3 left')).toMatchObject({ name: 'Booster box', price: { amount: 189, currency: 'S$' }, stock: 3 });
    expect(parseListing('Pre-orders open next week')).toEqual({ raw: 'Pre-orders open next week', code: undefined, name: 'Pre-orders open next week', price: undefined, stock: undefined });
    expect([needsTranslation('アルファモン'), needsTranslation('Omnimon')]).toEqual([true, false]);
  });
});

describe('what matters in a change', () => {
  const diff = {
    added: ['EX13-070 オメガモンX(パラレル) 3,980 円 在庫 : 2 点'],
    removed: ['EX13-099 シークレット 9,800 円 在庫 : ×'],
    changed: [
      pair('EX13-060 アルファモン(パラレル) 2,480 円 在庫 : 1 点', 'EX13-060 アルファモン(パラレル) 2,480 円 在庫 : ×'),
      pair('EX13-015 デューテモン(パラレル) 3,980 円 在庫 : ×', 'EX13-015 デューテモン(パラレル) 3,980 円 在庫 : 1 点'),
      pair('EX13-016 オメガモン(パラレル) 3,480 円 在庫 : 8 点', 'EX13-016 オメガモン(パラレル) 2,980 円 在庫 : 7 点'),
      pair('EX13-020 マグナモン(パラレル) 2,480 円 在庫 : 7 点', 'EX13-020 マグナモン(パラレル) 2,980 円 在庫 : 7 点'),
      pair('EX13-014 ジエスモン(パラレル) 1,980 円 在庫 : 3 点', 'EX13-014 ジエスモン(パラレル) 1,980 円 在庫 : 2 点'),
      pair('EX13-050 ドルモン 100 円 在庫 : 3 点', 'EX13-050 ドルモン(プロモ) 100 円 在庫 : 3 点'),
    ],
  };

  it('sorts changes into sold out, back in stock, price moves, stock counts and the rest', () => {
    const insight = classify(diff);
    expect(insight.soldOut.map(m => m.after.code)).toEqual(['EX13-060']);
    expect(insight.restocked.map(m => m.after.code)).toEqual(['EX13-015']);
    expect(insight.priceDown.map(m => m.after.code)).toEqual(['EX13-016']); // a price drop outranks its stock count
    expect(insight.priceUp.map(m => m.after.code)).toEqual(['EX13-020']);
    expect(insight.stock.map(m => m.after.code)).toEqual(['EX13-014']);
    expect(insight.other.map(m => m.after.code)).toEqual(['EX13-050']);
    expect(headline(insight)).toBe('1 sold out, 1 back in stock, 1 new, 1 price drop, 1 price rise, 1 stock change, 1 other change, 1 gone');
    expect(namesIn(insight)).toContain('オメガモンX(パラレル)');
  });

  it('writes a short alert with highlights first and the full list folded', () => {
    const text = changeMessage('Digimon EX13', 'https://yuyu-tei.jp/sell/digi/s/ex13', diff, { 'アルファモン(パラレル)': 'Alphamon (Parallel)', 'ジエスモン(パラレル)': 'Jesmon (Parallel)' });
    expect(text).toContain('<b>🔴 Sold out</b>\n• Alphamon (Parallel) · ¥2,480');
    expect(text).toContain('<b>🟢 Back in stock</b>\n• デューテモン(パラレル) · 1 left · ¥3,980'); // untranslated names stay as they are
    expect(text).toContain('<b>📈 Price up</b>\n• マグナモン(パラレル): ¥2,480 → <b>¥2,980</b>');
    expect(text).toContain('📦 <b>Stock</b>: Jesmon (Parallel) 3→2');
    expect(text).toContain('• EX13-060 Alphamon (Parallel) <i>(アルファモン(パラレル))</i>: ¥2,480, stock 1 → ×');
    expect(text).toContain('• EX13-050 ドルモン(プロモ): was: EX13-050 ドルモン 100 円 在庫 : 3 点');
    expect(text.indexOf('🔴 Sold out')).toBeLessThan(text.indexOf('<blockquote expandable>'));
  });
});
