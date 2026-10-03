// Ica's daily messages, run by the cloud runner (always on; it reads Firestore only and
// never contacts a website): the morning briefing and reminder alerts.
import { addDays, formatDue, longDate } from './capture.ts';
import { GREETING, escapeHtml } from './telegram.ts';
import type { Store } from './run.ts';

/** Matches Voracity's users/{uid}/settings/assistant (firestore.rules). */
export interface AssistantSettings { briefing: boolean; reminderAlerts: boolean; dayBefore: boolean; morning: string; timezone: string }
export const DEFAULT_SETTINGS: AssistantSettings = { briefing: true, reminderAlerts: true, dayBefore: true, morning: '08:00', timezone: 'Asia/Singapore' };

export interface Reminder { id: string; title: string; dueDate: string; revision?: number }
export interface Bookmark { id: string; title: string; url: string; createdAt: number }
/** Runner-only bookkeeping at users/{uid}/assistant/schedule. */
export interface Schedule { morningFor?: string; briefedAt?: number; alerted?: Record<string, string> }

export interface AssistantStore {
  settings(uid: string): Promise<Partial<AssistantSettings> | null>;
  schedule(uid: string): Promise<Schedule>;
  saveSchedule(uid: string, schedule: Schedule): Promise<void>;
  /** Unfinished reminders with a due date; only those due on `dueDate` when given. */
  openReminders(uid: string, dueDate?: string): Promise<Reminder[]>;
  unreadBookmarks(uid: string): Promise<Bookmark[]>;
}

export function settingsFrom(doc: Partial<AssistantSettings> | null): AssistantSettings {
  const s = { ...DEFAULT_SETTINGS, ...(doc ?? {}) };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.morning)) s.morning = DEFAULT_SETTINGS.morning;
  try { new Intl.DateTimeFormat('en', { timeZone: s.timezone }); } catch { s.timezone = DEFAULT_SETTINGS.timezone; }
  return s;
}

/** The owner's local date (YYYY-MM-DD) and time (HH:MM). */
export function localClock(now: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const LIST = 10;
const bullets = (items: string[]) => [...items.slice(0, LIST).map(item => '• ' + item), ...(items.length > LIST ? [`…and ${items.length - LIST} more`] : [])];
const ago = (ms: number, now: number) => { const h = Math.round((now - ms) / 3_600_000); return h < 1 ? 'just now' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`; };

export interface BriefingInput {
  today: string; dueToday: Reminder[]; overdue: Reminder[]; tomorrow: Reminder[];
  changes: { label: string; summary: string; at: number }[]; unread: Bookmark[]; now: number;
  /** Today's calendar, already formatted ("09:00–10:30 Lecture (LT1)"). */
  events?: string[];
  /** Parcels that need you or arrive today, already escaped ("Keyboard: out for delivery"). */
  parcels?: string[];
}

/** One "✓" button per reminder (at most five), each a single-tap, revision-checked "done". */
export function doneButtons(reminders: Reminder[]): Buttons | undefined {
  const rows = reminders.filter(r => r.revision !== undefined).slice(0, 5).map(r => {
    const data = `done:${r.id}:${r.revision}`;
    return data.length <= 64 ? [{ text: `✓ ${r.title.length > 30 ? r.title.slice(0, 29) + '…' : r.title}`, data }] : null;
  }).filter((row): row is { text: string; data: string }[] => !!row);
  return rows.length ? rows : undefined;
}

export function briefingMessage(b: BriefingInput) {
  const lines = [GREETING, `Good morning! Here's ${longDate(b.today)}.`];
  if (b.events?.length) lines.push('', '<b>Calendar</b>', ...bullets(b.events.map(escapeHtml)));
  if (b.dueToday.length) lines.push('', '<b>Due today</b>', ...bullets(b.dueToday.map(r => escapeHtml(r.title))));
  else lines.push('', 'Nothing due today.');
  if (b.overdue.length) lines.push('', '<b>Still open</b>', ...bullets(b.overdue.map(r => `${escapeHtml(r.title)} (was due ${formatDue(r.dueDate, b.today)})`)));
  if (b.tomorrow.length) lines.push('', '<b>Tomorrow</b>', ...bullets(b.tomorrow.map(r => escapeHtml(r.title))));
  if (b.parcels?.length) lines.push('', '<b>Parcels</b>', ...bullets(b.parcels));
  if (b.changes.length) lines.push('', '<b>Watches</b>', ...bullets(b.changes.map(c => `${escapeHtml(c.label)}: ${escapeHtml(c.summary)} (${ago(c.at, b.now)})`)));
  if (b.unread.length) lines.push('', `<b>Reading list</b>: ${b.unread.length} unread`, ...bullets(b.unread.slice(0, 3).map(item => escapeHtml(item.title))).slice(0, 3));
  return lines.join('\n');
}

export function morningReminderMessage(today: string, dueToday: Reminder[], overdue: Reminder[], tomorrow: Reminder[]) {
  const lines = [GREETING];
  if (dueToday.length) lines.push('<b>Due today</b>', ...bullets(dueToday.map(r => escapeHtml(r.title))));
  if (overdue.length) lines.push('<b>Still open</b>', ...bullets(overdue.map(r => `${escapeHtml(r.title)} (was due ${formatDue(r.dueDate, today)})`)));
  if (tomorrow.length) lines.push('<b>Tomorrow</b>', ...bullets(tomorrow.map(r => escapeHtml(r.title))));
  return lines.join('\n');
}

export function addedTodayMessage(reminders: Reminder[]) {
  return [GREETING, reminders.length === 1 ? 'Due today:' : 'Due today, added since this morning:', ...bullets(reminders.map(r => `<b>${escapeHtml(r.title)}</b>`))].join('\n');
}

export type Buttons = { text: string; data: string }[][];
export interface AssistantDeps {
  owners: Record<string, string>;
  store: Store & AssistantStore;
  send: (chatId: string, text: string, buttons?: Buttons) => Promise<void>;
  /** Today's events from the owner's private calendar feeds, if any are connected. */
  events?: (uid: string, today: string, timeZone: string) => Promise<string[]>;
  /** Parcels for the briefing (briefingParcels), when parcel tracking is set up. */
  parcels?: (uid: string, today: string) => Promise<string[]>;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Once a day at (or after) the owner's morning time: the briefing, or with the briefing
 * off, a reminder message when something is due. After the morning, reminders due today
 * that weren't in that message are sent once. Nothing repeats.
 */
export async function runAssistant(deps: AssistantDeps) {
  const now = deps.now ?? Date.now;
  const totals = { briefings: 0, alerts: 0, failures: 0 };
  for (const [uid, chatId] of Object.entries(deps.owners)) {
    const settings = settingsFrom(await deps.store.settings(uid));
    if (!settings.briefing && !settings.reminderAlerts) continue;
    const { date: today, time } = localClock(now(), settings.timezone);
    if (time < settings.morning) continue;
    const schedule = await deps.store.schedule(uid);
    const alerted = Object.fromEntries(Object.entries(schedule.alerted ?? {}).filter(([, day]) => day === today));
    const send = async (text: string, buttons?: Buttons) => { try { await deps.send(chatId, text, buttons); return true; } catch { totals.failures++; return false; } };

    if (schedule.morningFor !== today) {
      const open = await deps.store.openReminders(uid);
      const dueToday = open.filter(r => r.dueDate === today);
      const overdue = open.filter(r => r.dueDate < today).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      const tomorrow = settings.dayBefore ? open.filter(r => r.dueDate === addDays(today, 1)) : [];
      let sent = true;
      if (settings.briefing) {
        const [watches, states, unread] = await Promise.all([deps.store.watches(uid), deps.store.states(uid), deps.store.unreadBookmarks(uid)]);
        const since = schedule.briefedAt ?? now() - 86_400_000;
        const changes = watches.flatMap(watch => {
          const state = states.get(watch.id);
          return state?.changedAt && state.changedAt > since && state.summary ? [{ label: watch.label, summary: state.summary, at: state.changedAt }] : [];
        });
        const events = deps.events ? await deps.events(uid, today, settings.timezone).catch(() => []) : [];
        const parcels = deps.parcels ? await deps.parcels(uid, today).catch(() => []) : [];
        sent = await send(briefingMessage({ today, dueToday, overdue, tomorrow, changes, unread: unread.sort((a, b) => b.createdAt - a.createdAt), now: now(), events, parcels }), doneButtons([...dueToday, ...overdue]));
        if (sent) totals.briefings++;
      } else if (dueToday.length || overdue.length || tomorrow.length) {
        sent = await send(morningReminderMessage(today, dueToday, overdue, tomorrow), doneButtons([...dueToday, ...overdue]));
        if (sent) totals.alerts++;
      }
      // If Telegram is down, try the morning message again next run.
      if (sent) {
        for (const r of dueToday) alerted[r.id] = today;
        await deps.store.saveSchedule(uid, { morningFor: today, briefedAt: now(), alerted });
      }
      continue;
    }

    if (!settings.reminderAlerts) continue;
    const fresh = (await deps.store.openReminders(uid, today)).filter(r => alerted[r.id] !== today);
    if (!fresh.length) continue;
    if (await send(addedTodayMessage(fresh), doneButtons(fresh))) {
      totals.alerts++;
      for (const r of fresh) alerted[r.id] = today;
      await deps.store.saveSchedule(uid, { ...schedule, alerted });
    }
  }
  deps.log?.(`assistant: briefings ${totals.briefings}, reminder messages ${totals.alerts}, message failures ${totals.failures}`);
  return totals;
}
