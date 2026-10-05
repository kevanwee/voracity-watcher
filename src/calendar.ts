// Read-only calendar access through Google Calendar's "secret address in iCal format".
// No OAuth tokens are stored anywhere: the owner keeps the private feed URL as a runner
// secret and can revoke it in Google Calendar (Settings → Integrate calendar → Reset).
import ICAL from 'ical.js';
import { boundedText } from './agent-policy.ts';

export interface CalendarEvent {
  title: string;
  /** Local date (YYYY-MM-DD) the event starts on in the owner's time zone. */
  date: string;
  /** Local start time HH:MM, or '' for all-day events. */
  time: string;
  endTime: string;
  allDay: boolean;
  location: string;
  startMs: number;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_OCCURRENCES = 2000;
const pad = (n: number) => String(n).padStart(2, '0');

function localParts(ms: number, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

const dateOf = (t: ICAL.Time) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

/**
 * Events overlapping local dates [fromDate, toDate] (inclusive) from iCal text,
 * with recurring events expanded (RRULE, EXDATE, moved occurrences) and cancelled ones dropped.
 */
export function eventsBetween(icsTexts: string[], fromDate: string, toDate: string, timeZone: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  // Wide UTC window around the local dates; exact filtering happens per event below.
  const windowStart = Date.parse(`${fromDate}T00:00:00Z`) - 86_400_000, windowEnd = Date.parse(`${toDate}T23:59:59Z`) + 86_400_000;
  for (const text of icsTexts) {
    let root: ICAL.Component;
    try { root = new ICAL.Component(ICAL.parse(text)); } catch { continue; }
    for (const tz of root.getAllSubcomponents('vtimezone')) {
      try { ICAL.TimezoneService.register(new ICAL.Timezone(tz)); } catch { /* keep going */ }
    }
    const vevents = root.getAllSubcomponents('vevent');
    const exceptions = new Map<string, ICAL.Component[]>();
    for (const v of vevents) {
      if (v.hasProperty('recurrence-id')) {
        const uid = String(v.getFirstPropertyValue('uid'));
        exceptions.set(uid, [...(exceptions.get(uid) ?? []), v]);
      }
    }
    const add = (summary: string, location: string, status: string, start: ICAL.Time, end: ICAL.Time | null) => {
      if (status.toUpperCase() === 'CANCELLED') return;
      const title = (summary || '(no title)').slice(0, 200);
      if (start.isDate) {
        const first = dateOf(start);
        // DTEND is exclusive for all-day events.
        let lastDay = first;
        if (end) { const e = end.clone(); e.adjust(-1, 0, 0, 0); lastDay = dateOf(e) < first ? first : dateOf(e); }
        if (lastDay < fromDate || first > toDate) return;
        events.push({ title, date: first < fromDate ? fromDate : first, time: '', endTime: '', allDay: true, location, startMs: Date.parse(`${first}T00:00:00Z`) });
        return;
      }
      const startMs = start.toJSDate().getTime(), endMs = end ? end.toJSDate().getTime() : startMs;
      const s = localParts(startMs, timeZone), e = localParts(endMs, timeZone);
      if (e.date < fromDate || s.date > toDate) return;
      events.push({ title, date: s.date, time: s.time, endTime: e.date === s.date ? e.time : '', allDay: false, location, startMs });
    };
    for (const v of vevents) {
      if (v.hasProperty('recurrence-id')) continue;
      let event: ICAL.Event;
      try { event = new ICAL.Event(v); } catch { continue; }
      const status = String(v.getFirstPropertyValue('status') ?? '');
      for (const exception of exceptions.get(event.uid) ?? []) { try { event.relateException(exception); } catch { /* ignore */ } }
      if (!event.isRecurring()) {
        if (event.startDate) add(event.summary, event.location ?? '', status, event.startDate, event.endDate);
        continue;
      }
      const iterator = event.iterator();
      for (let i = 0, next = iterator.next(); next && i < MAX_OCCURRENCES; i++, next = iterator.next()) {
        const ms = next.toJSDate().getTime();
        if (ms > windowEnd) break;
        const details = event.getOccurrenceDetails(next);
        const endMs = details.endDate.toJSDate().getTime();
        if (endMs < windowStart) continue;
        const item = details.item;
        const itemStatus = String(item.component.getFirstPropertyValue('status') ?? status);
        add(item.summary, item.location ?? '', itemStatus, details.startDate, details.endDate);
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.title.localeCompare(b.title));
}

/** Fetch each private feed. Failures are counted, never logged with the address. */
export async function fetchCalendars(urls: string[], fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  const texts: string[] = [];
  let failed = 0;
  for (const url of urls) {
    signal?.throwIfAborted();
    try {
      const feedSignal = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
      const response = await fetcher(url, { signal: feedSignal, headers: { Accept: 'text/calendar,*/*;q=0.5' } });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); failed++; continue; }
      const length = Number(response.headers.get('content-length'));
      if (length > MAX_BYTES) { void response.body?.cancel().catch(() => {}); failed++; continue; }
      const text = await boundedText(response, MAX_BYTES, feedSignal);
      if (text.length > MAX_BYTES || !text.includes('BEGIN:VCALENDAR')) { failed++; continue; }
      texts.push(text);
    } catch { signal?.throwIfAborted(); failed++; }
  }
  return { texts, failed };
}

export function formatEvent(e: CalendarEvent) {
  const when = e.allDay ? 'All day' : e.endTime ? `${e.time}–${e.endTime}` : e.time;
  return `${when} ${e.title}${e.location ? ` (${e.location})` : ''}`;
}
