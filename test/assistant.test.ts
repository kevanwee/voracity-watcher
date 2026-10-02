import { describe, expect, it } from 'vitest';
import { localClock, runAssistant, settingsFrom, type AssistantSettings, type AssistantStore, type Bookmark, type Reminder, type Schedule } from '../src/assistant.ts';
import type { Store, Watch, WatchState } from '../src/run.ts';

const UID = 'owner1', CHAT = '4242';
// 2026-10-02 (Friday) in Singapore (UTC+8).
const at = (hhmm: string, day = '2026-10-02') => Date.parse(`${day}T${hhmm}:00+08:00`);

function setup(reminders: Reminder[], settings: Partial<AssistantSettings> | null = null, extra: { watches?: Watch[]; states?: Map<string, WatchState>; bookmarks?: Bookmark[] } = {}) {
  let schedule: Schedule = {};
  const list = [...reminders];
  const store: Store & AssistantStore = {
    watches: async () => extra.watches ?? [], states: async () => extra.states ?? new Map(), items: async () => new Map(),
    save: async () => {}, removeItems: async () => {}, heartbeat: async () => {},
    settings: async () => settings, schedule: async () => structuredClone(schedule), saveSchedule: async (_u, s) => { schedule = structuredClone(s); },
    openReminders: async (_u, dueDate) => list.filter(r => !dueDate || r.dueDate === dueDate),
    unreadBookmarks: async () => extra.bookmarks ?? [],
  };
  const sent: string[] = [];
  const telegram = { down: false };
  let clock = at('07:00');
  const run = () => runAssistant({ owners: { [UID]: CHAT }, store, now: () => clock, send: async (chat, text) => {
    expect(chat).toBe(CHAT);
    if (telegram.down) throw new Error('Telegram unavailable');
    sent.push(text);
  } });
  return { sent, run, list, telegram, set: (ms: number) => { clock = ms; }, schedule: () => schedule };
}

const r = (id: string, title: string, dueDate: string): Reminder => ({ id, title, dueDate });

describe('settings and time', () => {
  it('fills defaults and rejects invalid times and zones', () => {
    expect(settingsFrom(null)).toEqual({ briefing: true, reminderAlerts: true, dayBefore: true, morning: '08:00', timezone: 'Asia/Singapore' });
    expect(settingsFrom({ morning: '25:00', timezone: 'Mars/Base' })).toMatchObject({ morning: '08:00', timezone: 'Asia/Singapore' });
    expect(localClock(at('23:59'), 'Asia/Singapore')).toEqual({ date: '2026-10-02', time: '23:59' });
    expect(localClock(at('07:30'), 'Europe/London')).toEqual({ date: '2026-10-02', time: '00:30' });
  });
});

describe('morning briefing', () => {
  it('waits for the morning time, sends once, and includes reminders, watches and reading', async () => {
    const s = setup([r('a', 'File the brief', '2026-10-02'), r('b', 'Pay rent', '2026-09-29'), r('c', 'Exam <prep>', '2026-10-03'), r('d', 'Later', '2026-10-20')], null, {
      watches: [{ id: 'w1', label: 'EX13 singles', url: 'https://x', selector: '', ignore: '', interval: 5, enabled: true, createdAt: 1 }],
      states: new Map([['w1', { status: 'ok', checkedAt: at('06:00'), changedAt: at('05:00'), summary: '12 new' }]]),
      bookmarks: [{ id: 'k', title: 'Long read', url: 'https://y', createdAt: 1 }],
    });
    await s.run();
    expect(s.sent).toEqual([]); // 07:00 is before 08:00
    s.set(at('08:07'));
    await s.run();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toBe([
      'Doot Doot.', "Good morning! Here's Friday 2 October.",
      '', '<b>Due today</b>', '• File the brief',
      '', '<b>Still open</b>', '• Pay rent (was due Tue 29 Sep)',
      '', '<b>Tomorrow</b>', '• Exam &lt;prep&gt;',
      '', '<b>Watches</b>', '• EX13 singles: 12 new (3 h ago)',
      '', '<b>Reading list</b>: 1 unread', '• Long read',
    ].join('\n'));
    s.set(at('08:12'));
    await s.run();
    expect(s.sent).toHaveLength(1);
    // The next day brings a new briefing.
    s.set(at('08:01', '2026-10-03'));
    await s.run();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]).toContain("Here's Saturday 3 October.");
  });

  it('says when nothing is due, and arrives late rather than never', async () => {
    const s = setup([]);
    s.set(at('14:30'));
    await s.run();
    expect(s.sent[0]).toContain('Nothing due today.');
  });

  it('with the briefing off, sends a reminder message only when something is due', async () => {
    const s = setup([r('a', 'Call bank', '2026-10-05')], { briefing: false });
    s.set(at('09:00'));
    await s.run();
    expect(s.sent).toEqual([]);
    s.list.push(r('b', 'Submit form', '2026-10-03'));
    s.set(at('09:00', '2026-10-03'));
    await s.run();
    expect(s.sent).toEqual(['Doot Doot.\n<b>Due today</b>\n• Submit form']);
  });

  it('skips tomorrow when the day-before heads-up is off, and does nothing with both off', async () => {
    const s = setup([r('c', 'Exam', '2026-10-03')], { dayBefore: false });
    s.set(at('08:30'));
    await s.run();
    expect(s.sent[0]).not.toContain('Tomorrow');
    const off = setup([r('a', 'X', '2026-10-02')], { briefing: false, reminderAlerts: false });
    off.set(at('09:00'));
    await off.run();
    expect(off.sent).toEqual([]);
  });
});

describe('reminder alerts after the morning', () => {
  it('sends reminders added for today once, without repeating the morning ones', async () => {
    const s = setup([r('a', 'File the brief', '2026-10-02')]);
    s.set(at('08:00'));
    await s.run();
    s.list.push(r('b', 'Pick up parcel', '2026-10-02'));
    s.set(at('11:00'));
    await s.run();
    expect(s.sent[1]).toBe('Doot Doot.\nDue today:\n• <b>Pick up parcel</b>');
    s.set(at('11:05'));
    await s.run();
    expect(s.sent).toHaveLength(2);
    expect(s.schedule().alerted).toEqual({ a: '2026-10-02', b: '2026-10-02' });
  });

  it('keeps the morning message for the next run if Telegram is down', async () => {
    const s = setup([r('a', 'File the brief', '2026-10-02')]);
    s.telegram.down = true;
    s.set(at('08:00'));
    expect(await s.run()).toMatchObject({ briefings: 0, failures: 1 });
    expect(s.schedule().morningFor).toBeUndefined();
    s.telegram.down = false;
    s.set(at('08:05'));
    expect(await s.run()).toMatchObject({ briefings: 1 });
    expect(s.schedule().morningFor).toBe('2026-10-02');
    expect(s.sent).toHaveLength(1);
  });
});
