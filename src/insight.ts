// Reads shop listings ("EX13-060 アルファモン(パラレル) 2,480 円 在庫 : 1 点") into a code,
// name, price and stock, and sorts a diff into what matters: sold out, back in stock, new,
// price changes and stock changes. No AI here: names are translated separately (translate.ts).
import type { Diff } from './extract.ts';

export interface Price { amount: number; currency: string }
export interface Listing {
  raw: string;
  /** A leading code such as "EX13-060", when the line starts with one. */
  code?: string;
  name: string;
  price?: Price;
  /** A count, 0 for sold out, or 'in' when the shop only says it's in stock. */
  stock?: number | 'in';
}

const PRICES: { re: RegExp; currency: string }[] = [
  { re: /([\d,]+)\s*円/, currency: '¥' },
  { re: /[¥￥]\s*([\d,]+)/, currency: '¥' },
  { re: /S\$\s*([\d,]+(?:\.\d{1,2})?)/i, currency: 'S$' },
  { re: /US?\$\s*([\d,]+(?:\.\d{1,2})?)/i, currency: 'US$' },
  { re: /\$\s*([\d,]+(?:\.\d{1,2})?)/, currency: '$' },
];
const STOCKS: { re: RegExp; value: (m: RegExpMatchArray) => number | 'in' }[] = [
  { re: /在庫\s*[:：]?\s*(\d+)\s*点?/, value: m => Number(m[1]) },
  { re: /在庫\s*[:：]?\s*[×✕✖xX]/, value: () => 0 },
  { re: /(?:sold\s*out|out\s+of\s+stock|売り切れ|品切れ|完売)/i, value: () => 0 },
  { re: /(\d+)\s*(?:left|in stock|available)/i, value: m => Number(m[1]) },
  { re: /\bin\s+stock\b/i, value: () => 'in' },
];

/** Japanese or Chinese characters that are worth translating. */
export const needsTranslation = (text: string) => /[\u3040-\u30ff\u3400-\u9fff]/.test(text);

export function parseListing(raw: string): Listing {
  let rest = ` ${raw} `;
  const first = raw.split(' ')[0];
  const code = first.length >= 3 && /\d/.test(first) && /^[A-Za-z0-9-]+$/.test(first) ? first : undefined;
  if (code) rest = rest.replace(` ${code} `, ' ');
  let price: Price | undefined, stock: number | 'in' | undefined;
  for (const { re, currency } of PRICES) {
    const m = rest.match(re);
    if (m) { price = { amount: Number(m[1].replace(/,/g, '')), currency }; rest = rest.replace(m[0], ' '); break; }
  }
  for (const { re, value } of STOCKS) {
    const m = rest.match(re);
    if (m) { stock = value(m); rest = rest.replace(m[0], ' '); break; }
  }
  return { raw, code, name: rest.replace(/\s+/g, ' ').trim() || raw, price, stock };
}

export interface Move { before: Listing; after: Listing }
export interface Insight {
  soldOut: Move[];
  restocked: Move[];
  priceDown: Move[];
  priceUp: Move[];
  /** Stock counts that moved without selling out or coming back. */
  stock: Move[];
  /** Changed in some other way (name, edition, wording). */
  other: Move[];
  added: Listing[];
  removed: Listing[];
}

const available = (stock: Listing['stock']) => stock === 'in' || (typeof stock === 'number' && stock > 0);

export function classify(diff: Diff): Insight {
  const insight: Insight = { soldOut: [], restocked: [], priceDown: [], priceUp: [], stock: [], other: [], added: diff.added.map(parseListing), removed: diff.removed.map(parseListing) };
  for (const pair of diff.changed) {
    const move = { before: parseListing(pair.before), after: parseListing(pair.after) };
    const { before, after } = move;
    let placed = false;
    if (before.stock !== undefined && after.stock !== undefined) {
      if (available(before.stock) && after.stock === 0) { insight.soldOut.push(move); placed = true; }
      else if (before.stock === 0 && available(after.stock)) { insight.restocked.push(move); placed = true; }
    }
    if (before.price && after.price && before.price.currency === after.price.currency && before.price.amount !== after.price.amount) {
      (after.price.amount < before.price.amount ? insight.priceDown : insight.priceUp).push(move); placed = true;
    }
    if (!placed && before.stock !== after.stock && before.stock !== undefined && after.stock !== undefined) { insight.stock.push(move); placed = true; }
    if (!placed) insight.other.push(move);
  }
  return insight;
}

/** "1 sold out, 1 price drop, 6 stock changes": for the alert's first line, Voracity and the briefing. */
export function headline(insight: Insight) {
  const parts: string[] = [];
  const add = (n: number, one: string, many = `${one}s`) => { if (n) parts.push(`${n} ${n === 1 ? one : many}`); };
  add(insight.soldOut.length, 'sold out', 'sold out');
  add(insight.restocked.length, 'back in stock', 'back in stock');
  add(insight.added.length, 'new', 'new');
  add(insight.priceDown.length, 'price drop');
  add(insight.priceUp.length, 'price rise');
  add(insight.stock.length, 'stock change');
  add(insight.other.length, 'other change');
  add(insight.removed.length, 'gone', 'gone');
  return parts.join(', ');
}

/** All the names an alert would show, for translation. */
export function namesIn(insight: Insight) {
  const moves = [...insight.soldOut, ...insight.restocked, ...insight.priceDown, ...insight.priceUp, ...insight.stock, ...insight.other];
  return [...new Set([...moves.flatMap(m => [m.before.name, m.after.name]), ...insight.added.map(l => l.name), ...insight.removed.map(l => l.name)])];
}

export const formatPrice = (price?: Price) => (price ? `${price.currency}${price.amount.toLocaleString('en-US')}` : '');
export const formatStock = (stock: Listing['stock']) => (stock === undefined ? '' : stock === 0 ? 'sold out' : stock === 'in' ? 'in stock' : `${stock} left`);
