// Pure rules for standing pages ("one page I can check every morning"), kept out of runner.ts and scheduler.ts so
// they can be tested without a database or Hermes.
import type { Page } from '../shared/types';
import { toMinutes } from './clock';

/** Pages refresh this long before the morning brief, so the brief sees today's version. */
export const REFRESH_LEAD_MIN = 30;
export const MAX_PAGES = 10;

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
