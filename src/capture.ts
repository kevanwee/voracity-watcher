// Turns a Telegram message into a proposed Voracity card or reading-list bookmark.
// Nothing is saved here: the owner confirms each proposal with a button first.

export type Proposal =
  | { kind: 'reminder'; title: string; body: string; dueDate: string }
  | { kind: 'note'; title: string; body: string }
  | { kind: 'bookmark'; url: string; title: string }
  | { kind: 'parcel'; number: string; label: string };

// Field limits match Voracity's model.ts / bookmarks.ts and firestore.rules.
export const LIMITS = { title: 120, body: 10000, url: 2048, bookmarkTitle: 200, parcelLabel: 60 } as const;

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromIso = (value: string) => new Date(`${value}T00:00:00Z`);
export const addDays = (date: string, days: number) => { const d = fromIso(date); d.setUTCDate(d.getUTCDate() + days); return iso(d); };

function validDate(y: number, m: number, d: number) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? iso(date) : null;
}

/** A day and month without a year means the next time that date comes round. */
function upcoming(today: string, m: number, d: number) {
  const year = Number(today.slice(0, 4));
  const thisYear = validDate(year, m, d);
  if (thisYear && thisYear >= today) return thisYear;
  return validDate(year + 1, m, d);
}

const DATE_PATTERNS: { re: RegExp; resolve: (m: RegExpMatchArray, today: string) => string | null }[] = [
  { re: /\b(today|tonight|later today)\b/i, resolve: (_m, t) => t },
  { re: /\b(tomorrow|tmrw?|tmr)\b/i, resolve: (_m, t) => addDays(t, 1) },
  { re: /\bin\s+(\d{1,3})\s+(day|days|week|weeks)\b/i, resolve: (m, t) => addDays(t, Number(m[1]) * (/week/i.test(m[2]) ? 7 : 1)) },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, resolve: m => validDate(Number(m[1]), Number(m[2]), Number(m[3])) },
  { re: /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/i, resolve: (m, t) => {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return m[3] ? validDate(Number(m[3]), month, Number(m[1])) : upcoming(t, month, Number(m[1]));
  } },
  { re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i, resolve: (m, t) => {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return m[3] ? validDate(Number(m[3]), month, Number(m[2])) : upcoming(t, month, Number(m[2]));
  } },
  // Day first, as written in Singapore: 5/10 is 5 October.
  { re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, resolve: (m, t) => {
    if (!m[3]) return upcoming(t, Number(m[2]), Number(m[1]));
    const year = Number(m[3].length === 2 ? '20' + m[3] : m[3]);
    return validDate(year, Number(m[2]), Number(m[1]));
  } },
  { re: /\b(?:(this|next)\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\b/i, resolve: (m, t) => {
    const target = WEEKDAYS.findIndex(day => day.startsWith(m[2].slice(0, 3).toLowerCase()));
    const current = fromIso(t).getUTCDay();
    // "Friday", "this Friday" and "next Friday" all mean the coming Friday, never today.
    return addDays(t, (target - current + 7) % 7 || 7);
  } },
];

/** Pull a due date out of free text; returns the text without the date phrase. */
export function extractDue(text: string, today: string): { rest: string; dueDate: string } {
  for (const { re, resolve } of DATE_PATTERNS) {
    const match = text.match(re);
    if (!match) continue;
    const dueDate = resolve(match, today);
    if (!dueDate) continue;
    const before = text.slice(0, match.index).replace(/\s*\b(on|by|due|for|this|next|at)\s*$/i, '');
    const rest = (before + ' ' + text.slice(match.index! + match[0].length)).replace(/\s+([,.!?])/g, '$1');
    return { rest: tidy(rest), dueDate };
  }
  return { rest: tidy(text), dueDate: '' };
}

const tidy = (value: string) => value.replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,;:-]+$/g, '').trim();
const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function split(text: string) {
  const [first, ...rest] = text.split('\n');
  let title = first.trim(), body = rest.join('\n').trim();
  if (title.length > LIMITS.title) { body = (title.slice(LIMITS.title - 1) + (body ? '\n' + body : '')).trim(); title = title.slice(0, LIMITS.title - 1) + '…'; }
  return { title, body: body.slice(0, LIMITS.body) };
}

export function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && url.href.length <= LIMITS.url ? url.href : '';
  } catch { return ''; }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/i;

/**
 * Recognises:
 *   "/remind …", "remind me (to) …", "reminder: …"  → reminder (with an optional date)
 *   "/note …", "note: …"                              → note
 *   "/save <url>", "save <url>", or a message that is mostly a link → reading list
 * Returns null for anything else.
 */
export function parseCapture(text: string, today: string): Proposal | { error: string } | null {
  const message = text.trim();
  let match: RegExpMatchArray | null;
  // "track SPXSG0123… keyboard" or "/track …": the word after "track" must look like a
  // tracking number, so "track my budget" is still a question.
  if ((match = message.match(/^(\/track(?:@\w+)?|track)(?:\s+([\s\S]*))?$/i))) {
    const explicit = match[1].startsWith('/');
    const [first = '', ...words] = (match[2] ?? '').trim().split(/\s+/);
    const number = first.replace(/[.]/g, '').toUpperCase();
    if (/^[A-Z0-9-]{6,40}$/.test(number) && /\d/.test(number)) {
      const label = capitalise(tidy(words.join(' '))).slice(0, LIMITS.parcelLabel) || `Parcel ending ${number.slice(-4)}`;
      return { kind: 'parcel', number, label };
    }
    if (explicit) return { error: 'Send /track with the tracking number, then a name: “/track SPXSG012345678901 keyboard”.' };
  }
  if ((match = message.match(/^(?:\/remind(?:@\w+)?|remind\s+me(?:\s+to)?|reminder\s*:)\s*([\s\S]*)$/i))) {
    // The date and title come from the first line; any further lines are the details.
    const [first, ...more] = match[1].replace(/^to\s+/i, '').split('\n');
    const { rest, dueDate } = extractDue(first, today);
    if (!rest) return { error: 'What should I remind you about? Try “remind me to call the bank Friday”.' };
    const { title, body } = split([capitalise(rest), ...more].join('\n'));
    return { kind: 'reminder', title, body, dueDate };
  }
  if ((match = message.match(/^(?:\/note(?:@\w+)?|note\s*:)\s*([\s\S]*)$/i))) {
    if (!match[1].trim()) return { error: 'What should the note say? Try “note: book the venue”.' };
    const { title, body } = split(capitalise(match[1].trim()));
    return { kind: 'note', title, body };
  }
  const explicitSave = message.match(/^(?:\/save(?:@\w+)?|save)\s+([\s\S]+)$/i);
  const link = (explicitSave ? explicitSave[1] : message).match(URL_RE);
  if (link) {
    const url = safeUrl(link[0].replace(/[),.;!?]+$/, ''));
    const remainder = tidy((explicitSave ? explicitSave[1] : message).replace(link[0], ''));
    // Plain messages count as "save this link" only when the link is most of the message.
    if (url && (explicitSave || remainder.length <= 80)) {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return { kind: 'bookmark', url, title: (remainder || host).slice(0, LIMITS.bookmarkTitle) };
    }
    if (explicitSave) return { error: 'That link does not look like a web address starting with http:// or https://.' };
  } else if (explicitSave) return { error: 'Send /save followed by a link.' };
  return null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Friday 2 October" */
export function longDate(date: string) {
  const d = fromIso(date);
  return `${WEEKDAYS[d.getUTCDay()].replace(/^./, c => c.toUpperCase())} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}
export function formatDue(dueDate: string, today: string) {
  if (!dueDate) return 'no due date';
  if (dueDate === today) return 'today';
  if (dueDate === addDays(today, 1)) return 'tomorrow';
  const d = fromIso(dueDate);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].replace(/^./, c => c.toUpperCase())}${dueDate.slice(0, 4) === today.slice(0, 4) ? '' : ' ' + dueDate.slice(0, 4)}`;
}
