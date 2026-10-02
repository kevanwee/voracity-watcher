import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

export const MAX_ITEMS = 500;
export const MAX_ITEM_CHARS = 300;

const DROP = 'script, style, noscript, template, svg, iframe, head';
// Controls repeat on every item (cart buttons, quantity steppers) and add noise.
const CONTROLS = 'button, input, select, textarea, option, [role="button"], a.btn, .btn';
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);

export class SelectorError extends Error {}

function textOf(node: AnyNode, out: string[], lines: boolean) {
  if (node.type === 'text') { out.push((node as { data: string }).data); return; }
  if (!('children' in node)) return;
  const name = 'name' in node ? String(node.name).toLowerCase() : '';
  const separator = lines && BLOCK.has(name) ? '\n' : ' ';
  out.push(separator);
  for (const child of node.children as AnyNode[]) textOf(child, out, lines);
  out.push(separator);
}

const squash = (value: string) => value.replace(/[\s 　]+/g, ' ').trim();

function clean(text: string, ignore: RegExp | null) {
  const value = squash(ignore ? text.replace(ignore, ' ') : text);
  return value.length > MAX_ITEM_CHARS ? value.slice(0, MAX_ITEM_CHARS - 1) + '…' : value;
}

export function compileIgnore(pattern: string) {
  if (!pattern.trim()) return null;
  try { return new RegExp(pattern, 'gu'); } catch { throw new SelectorError('the ignore pattern is not a valid regular expression'); }
}

/**
 * Items to compare. With a selector, each matching element is one item (its
 * controls removed). Without one, each visible line of the page is an item.
 * Duplicates are kept once, in page order.
 */
export function extractItems(html: string, selector: string, ignorePattern = ''): string[] {
  const $ = cheerio.load(html);
  $(DROP).remove();
  const ignore = compileIgnore(ignorePattern);
  const items: string[] = [];
  if (selector.trim()) {
    let matches;
    try { matches = $(selector); } catch { throw new SelectorError('the CSS selector is not valid'); }
    matches.each((_, element) => {
      const copy = $(element).clone();
      copy.find(CONTROLS).remove();
      const out: string[] = [];
      for (const node of copy.toArray()) textOf(node, out, false);
      items.push(clean(out.join(''), ignore));
    });
  } else {
    const out: string[] = [];
    for (const node of $('body').toArray()) textOf(node, out, true);
    for (const line of out.join('').split('\n')) items.push(clean(line, ignore));
  }
  return [...new Set(items.filter(Boolean))].slice(0, MAX_ITEMS);
}

export interface Diff { added: string[]; removed: string[]; changed: { before: string; after: string }[] }

/** A leading code such as "BT26-050" identifies the same entry across price or stock changes. */
function keyOf(item: string) {
  const token = item.split(' ')[0];
  return token.length >= 3 && /\d/.test(token) ? token : null;
}

export function diffItems(before: string[], after: string[]): Diff {
  const old = new Set(before), now = new Set(after);
  let added = after.filter(item => !old.has(item));
  let removed = before.filter(item => !now.has(item));
  const changed: Diff['changed'] = [];
  const count = (list: string[]) => {
    const map = new Map<string, string[]>();
    for (const item of list) { const key = keyOf(item); if (key) map.set(key, [...(map.get(key) ?? []), item]); }
    return map;
  };
  const addedKeys = count(added), removedKeys = count(removed);
  for (const [key, list] of addedKeys) {
    const was = removedKeys.get(key);
    if (list.length === 1 && was?.length === 1) changed.push({ before: was[0], after: list[0] });
  }
  if (changed.length) {
    const pairedAfter = new Set(changed.map(pair => pair.after)), pairedBefore = new Set(changed.map(pair => pair.before));
    added = added.filter(item => !pairedAfter.has(item));
    removed = removed.filter(item => !pairedBefore.has(item));
  }
  return { added, removed, changed };
}

export const isEmptyDiff = (diff: Diff) => !diff.added.length && !diff.removed.length && !diff.changed.length;

export function summarise(diff: Diff) {
  const parts = [];
  if (diff.added.length) parts.push(`${diff.added.length} new`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  if (diff.removed.length) parts.push(`${diff.removed.length} gone`);
  return parts.join(', ');
}
