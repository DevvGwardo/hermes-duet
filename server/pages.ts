// Pure rules for standing pages ("one page I can check every morning"), kept out of runner.ts and scheduler.ts so
// they can be tested without a database or Hermes.
import type { Page, Task } from '../shared/types';
import { toMinutes } from './clock';

/** Pages refresh this long before the morning brief, so the brief sees today's version. */
export const REFRESH_LEAD_MIN = 30;
export const MAX_PAGES = 10;
/** A brief that comes due while a refresh is still running waits this long at most, then goes ahead without it. */
export const BRIEF_HOLD_MIN = 30;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Local "HH:MM" of the daily refresh. Clamped at midnight rather than wrapping into the previous day's date. */
export function refreshTime(briefTime: string): string {
  return hhmm(Math.max(0, toMinutes(briefTime) - REFRESH_LEAD_MIN));
}

/**
 * Pages whose refresh should start now: today's refresh time has passed, the page hasn't been refreshed today,
 * and its last refresh isn't still going. A Mac that wakes late catches up until midday, like the brief does;
 * after that the day is skipped rather than rebuilding a "morning" page in the afternoon.
 */
export function pagesDue(pages: Page[], now: { date: string; minutes: number }, briefTime: string, refreshing: (p: Page) => boolean): Page[] {
  const due = toMinutes(refreshTime(briefTime));
  if (now.minutes < due || now.minutes >= Math.max(due + 1, 12 * 60)) return [];
  return pages.filter((p) => p.refreshed_on !== now.date && !refreshing(p));
}

/** Normalize save_page arguments. A new page needs all three fields; an update keeps whatever it doesn't pass. */
export function pageInput(raw: Record<string, unknown>, existing?: Page | null): { title: string; instructions: string; file_id: string } {
  const out = {
    title: text(raw.title, 120) || existing?.title || '',
    instructions: text(raw.instructions, 20_000) || existing?.instructions || '',
    file_id: text(raw.file_id, 64) || existing?.file_id || '',
  };
  if (!out.file_id) throw new Error('missing file_id: deliver the page with deliver_file first and pass the file id it returns');
  if (!out.title) throw new Error('missing title');
  if (!out.instructions) throw new Error('missing instructions: say how to rebuild the page from scratch each morning');
  return out;
}

/** Whether the due brief should keep waiting: some page is still refreshing and the hold hasn't run out. */
export function holdBrief(refreshing: boolean, heldSince: number | null, now: number): boolean {
  return refreshing && (heldSince === null || now - heldSince < BRIEF_HOLD_MIN * 60_000);
}

/**
 * How many ms a scheduled brief already in the queue should still wait for page refreshes; 0 means launch it.
 * The scheduler's hold only works before it queues the brief. A brief queued during a Hermes outage would start in
 * the same pass as the refreshes queued before it, so for BRIEF_HOLD_MIN after Hermes comes back (`backAt`) it waits
 * while any refresh is queued or running. Outside that window the scheduler has already held it, so no second wait.
 */
export function briefWait(refreshing: boolean, backAt: number | null, now: number): number {
  if (!refreshing || backAt === null) return 0;
  return Math.max(0, backAt + BRIEF_HOLD_MIN * 60_000 - now);
}

/**
 * Which refresh to cancel when a page is stopped: one still in flight, so it can't deliver over the file afterwards,
 * unless that refresh is the caller itself (a refresh run calling save_page remove would cancel its own tool call).
 */
export function refreshToCancel(page: Page, refreshing: boolean, callerTask?: string | null): string | null {
  return page.task_id && refreshing && page.task_id !== callerTask ? page.task_id : null;
}

/**
 * A refresh lost its run to a Hermes restart. Nobody asked for a scheduled refresh, so it gets no "Pick it back up?"
 * card or push: the first interruption starts it over on its own, and a second one ends it as a failed refresh
 * (the muted card with "Try again", and the brief says it failed). The reason is what the failure records; a task
 * that already ended (the agent marked it done, or the page was stopped) is never restarted, and keeps its outcome.
 */
export function afterInterruption(task: Pick<Task, 'status' | 'instructions'>, restarted: boolean): 'restart' | { fail: string } {
  const open = task.status !== 'done' && task.status !== 'cancelled';
  if (open && !restarted && task.instructions) return 'restart';
  return { fail: restarted ? 'Interrupted twice: Hermes restarted during the refresh and again when it started over.' : 'Interrupted: Hermes restarted mid-refresh.' };
}

/** One line per page for the brief prompt: today's change, or why there isn't one. */
export function pageBriefLine(page: Page, today: string, refreshing: boolean): string {
  const head = `- "${page.title}" (page ${page.id}): `;
  if (refreshing) return `${head}today's refresh is still running, so this brief can't say what changed.`;
  if (page.refreshed_on !== today) return `${head}not refreshed yet today.`;
  if (!page.task_id) return `${head}set up today, so there is no earlier version to compare with.`;
  if (page.last_ok) return `${head}refreshed. What changed: ${page.changed || 'the refresh did not say.'}`;
  if (page.last_ok === false) return `${head}today's refresh failed (${page.last_result || 'no reason given'}); the page still shows the previous version.`;
  return `${head}today's refresh was stopped before it finished; the page still shows the previous version.`;
}
