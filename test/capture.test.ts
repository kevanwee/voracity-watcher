import { describe, expect, it } from 'vitest';
import { extractDue, formatDue, longDate, parseCapture } from '../src/capture.ts';

const TODAY = '2026-10-02'; // a Friday

describe('due dates', () => {
  it.each([
    ['call mum today', 'call mum', '2026-10-02'],
    ['pay rent tomorrow', 'pay rent', '2026-10-03'],
    ['pay rent tmr', 'pay rent', '2026-10-03'],
    ['file the brief Monday', 'file the brief', '2026-10-05'],
    ['file the brief on Friday', 'file the brief', '2026-10-09'], // never today
    ['file the brief next fri', 'file the brief', '2026-10-09'],
    ['submit essay by 5 Oct', 'submit essay', '2026-10-05'],
    ['submit essay Oct 5th', 'submit essay', '2026-10-05'],
    ['renew passport 3 Jan', 'renew passport', '2027-01-03'], // already past this year
    ['renew passport 3 January 2028', 'renew passport', '2028-01-03'],
    ['dentist 2026-11-20', 'dentist', '2026-11-20'],
    ['dentist 20/11', 'dentist', '2026-11-20'], // day first
    ['dentist 20/11/27', 'dentist', '2027-11-20'],
    ['review notes in 3 days', 'review notes', '2026-10-05'],
    ['review notes in 2 weeks', 'review notes', '2026-10-16'],
    ['buy milk', 'buy milk', ''],
  ])('%s', (text, rest, dueDate) => {
    expect(extractDue(text, TODAY)).toEqual({ rest, dueDate });
  });
  it('ignores impossible dates and words that only look like days', () => {
    expect(extractDue('meeting 31/2', TODAY).dueDate).toBe('');
    expect(extractDue('plan the month ahead', TODAY)).toEqual({ rest: 'plan the month ahead', dueDate: '' });
    expect(extractDue('a sunny walk', TODAY).dueDate).toBe('');
  });
  it('formats due dates for messages', () => {
    expect(formatDue('2026-10-02', TODAY)).toBe('today');
    expect(formatDue('2026-10-03', TODAY)).toBe('tomorrow');
    expect(formatDue('2026-10-09', TODAY)).toBe('Fri 9 Oct');
    expect(formatDue('2027-01-03', TODAY)).toBe('Sun 3 Jan 2027');
    expect(formatDue('', TODAY)).toBe('no due date');
    expect(longDate(TODAY)).toBe('Friday 2 October');
  });
});

describe('capture messages', () => {
  it('recognises reminders in several phrasings', () => {
    expect(parseCapture('remind me to file the brief Friday', TODAY)).toEqual({ kind: 'reminder', title: 'File the brief', body: '', dueDate: '2026-10-09' });
    expect(parseCapture('Remind me call the bank', TODAY)).toMatchObject({ kind: 'reminder', title: 'Call the bank', dueDate: '' });
    expect(parseCapture('/remind@aeonofvoracity_bot renew licence 20/11', TODAY)).toMatchObject({ title: 'Renew licence', dueDate: '2026-11-20' });
    expect(parseCapture('reminder: exam prep tomorrow\nchapters 3-5', TODAY)).toEqual({ kind: 'reminder', title: 'Exam prep', body: 'chapters 3-5', dueDate: '2026-10-03' });
  });
  it('recognises notes, links and saves', () => {
    expect(parseCapture('note: book the venue', TODAY)).toEqual({ kind: 'note', title: 'Book the venue', body: '' });
    expect(parseCapture('/note ideas\nline two', TODAY)).toEqual({ kind: 'note', title: 'Ideas', body: 'line two' });
    expect(parseCapture('https://www.example.com/a?b=1.', TODAY)).toEqual({ kind: 'bookmark', url: 'https://www.example.com/a?b=1', title: 'example.com' });
    expect(parseCapture('read later https://example.com/x', TODAY)).toEqual({ kind: 'bookmark', url: 'https://example.com/x', title: 'read later' });
    expect(parseCapture('/save https://example.com/y Great article', TODAY)).toMatchObject({ kind: 'bookmark', title: 'Great article' });
  });
  it('splits long titles into the body and rejects unsafe or empty input', () => {
    const long = parseCapture('note: ' + 'x'.repeat(150), TODAY) as { title: string; body: string };
    expect(long.title).toHaveLength(120);
    expect(long.body.length).toBeGreaterThan(0);
    expect(parseCapture('/save javascript:alert(1)', TODAY)).toEqual({ error: 'Send /save followed by a link.' });
    expect(parseCapture('/save https://user:pw@example.com', TODAY)).toMatchObject({ error: expect.stringContaining('does not look like') });
    expect(parseCapture('note:', TODAY)).toMatchObject({ error: expect.any(String) });
    expect(parseCapture('how are you', TODAY)).toBeNull();
    // A long message that merely contains a link is not treated as "save this link".
    expect(parseCapture(`I was reading ${'about many things '.repeat(6)}https://example.com today`, TODAY)).toBeNull();
  });
});
