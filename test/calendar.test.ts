import { describe, expect, it } from 'vitest';
import { eventsBetween, fetchCalendars, formatEvent } from '../src/calendar.ts';

// Synthetic feed in the shape Google Calendar exports (not anyone's real calendar).
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'BEGIN:VTIMEZONE', 'TZID:Asia/Singapore', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:+08', 'DTSTART:19700101T000000', 'END:STANDARD', 'END:VTIMEZONE',
  // Every Friday 09:00-10:30 Singapore time, except 9 Oct; the 16 Oct class moves to 14:00.
  'BEGIN:VEVENT', 'UID:lecture@x', 'SUMMARY:Contract law lecture', 'LOCATION:LT1', 'DTSTART;TZID=Asia/Singapore:20260918T090000', 'DTEND;TZID=Asia/Singapore:20260918T103000',
  'RRULE:FREQ=WEEKLY;BYDAY=FR', 'EXDATE;TZID=Asia/Singapore:20261009T090000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:lecture@x', 'RECURRENCE-ID;TZID=Asia/Singapore:20261016T090000', 'SUMMARY:Contract law lecture (moved)', 'DTSTART;TZID=Asia/Singapore:20261016T140000', 'DTEND;TZID=Asia/Singapore:20261016T153000', 'END:VEVENT',
  // All-day, two days (DTEND is exclusive).
  'BEGIN:VEVENT', 'UID:trip@x', 'SUMMARY:Moot <trip>', 'DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261004', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:gone@x', 'SUMMARY:Cancelled call', 'STATUS:CANCELLED', 'DTSTART:20261002T020000Z', 'DTEND:20261002T030000Z', 'END:VEVENT',
  // 17:30 UTC on the 2nd is 01:30 on the 3rd in Singapore.
  'BEGIN:VEVENT', 'UID:late@x', 'SUMMARY:Late call', 'DTSTART:20261002T173000Z', 'DTEND:20261002T180000Z', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('calendar feed', () => {
  it('expands repeats, skips exclusions and cancellations, and uses local dates', () => {
    const friday = eventsBetween([ICS], '2026-10-02', '2026-10-02', 'Asia/Singapore');
    expect(friday.map(formatEvent)).toEqual(['All day Moot <trip>', '09:00–10:30 Contract law lecture (LT1)']);
    const saturday = eventsBetween([ICS], '2026-10-03', '2026-10-03', 'Asia/Singapore');
    expect(saturday.map(formatEvent)).toEqual(['All day Moot <trip>', '01:30–02:00 Late call']);
    expect(eventsBetween([ICS], '2026-10-04', '2026-10-04', 'Asia/Singapore')).toEqual([]);
    expect(eventsBetween([ICS], '2026-10-09', '2026-10-09', 'Asia/Singapore')).toEqual([]); // excluded
    // A moved occurrence replaces the original's details (this one has no location).
    expect(eventsBetween([ICS], '2026-10-16', '2026-10-16', 'Asia/Singapore').map(formatEvent)).toEqual(['14:00–15:30 Contract law lecture (moved)']);
    expect(eventsBetween([ICS], '2026-10-23', '2026-10-23', 'Asia/Singapore').map(e => e.time)).toEqual(['09:00']);
  });
  it('lists a range in order and shows times in another zone', () => {
    const week = eventsBetween([ICS], '2026-10-01', '2026-10-17', 'Asia/Singapore');
    expect(week.map(e => e.date)).toEqual(['2026-10-02', '2026-10-02', '2026-10-03', '2026-10-16']);
    expect(eventsBetween([ICS], '2026-10-02', '2026-10-02', 'Europe/London').find(e => !e.allDay)?.time).toBe('02:00');
  });
  it('ignores unreadable feeds and only accepts real calendars over the network', async () => {
    expect(eventsBetween(['not a calendar'], '2026-10-02', '2026-10-02', 'Asia/Singapore')).toEqual([]);
    const fetcher = (async (url: string) => url.endsWith('/ok.ics') ? new Response(ICS) : url.endsWith('/html') ? new Response('<html>') : new Response('', { status: 404 })) as unknown as typeof fetch;
    const result = await fetchCalendars(['https://x/ok.ics', 'https://x/html', 'https://x/missing'], fetcher);
    expect(result.texts).toHaveLength(1);
    expect(result.failed).toBe(2);
  });
});
