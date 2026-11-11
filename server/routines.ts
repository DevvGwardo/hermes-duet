// User-defined recurring routines: plain-language schedules, next-run math and validation. Pure on purpose — the
// runner, the HTTP API and the web app all import from here, and none of them should need the database to do it.
import type { Routine, RoutineSchedule } from '../shared/types';
import { localParts, toMinutes } from './clock';
import { UserError } from './errors';

export const ROUTINE_TITLE_MAX = 120;
export const ROUTINE_PROMPT_MAX = 6000;
/** A routine can be as frequent as a quarter hour and as rare as once a week. */
export const ROUTINE_MIN_INTERVAL = 15;
export const ROUTINE_MAX_INTERVAL = 10080; // 7 days

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What a create or update carries, after validation. */
export interface RoutineInput {
  title: string;
  prompt: string;
  schedule: RoutineSchedule;
  channel_id?: string;
  enabled: boolean;
}

/**
 * Weekday numbers, accepting both the 0-6 (Sunday..Saturday) this app stores and the 1-7 (Monday..Sunday) a person
 * writing a schedule naturally means. Duplicates collapse, the result is sorted, and at least one day is required.
 */
export function normalizeWeekdays(raw: unknown): number[] {
  if (!Array.isArray(raw)) throw new UserError('weekly routines need a weekdays list');
  const days = new Set<number>();
  for (const d of raw) {
    if (typeof d !== 'number' || !Number.isInteger(d)) throw new UserError('weekdays must be whole numbers');
    // 1-7 is Monday..Sunday, so 7 means Sunday — the same day as 0 in the 0-6 form.
    const n = d >= 1 && d <= 7 ? d % 7 : d;
    if (n < 0 || n > 6) throw new UserError('weekdays must be 0-6 (Sunday-Saturday) or 1-7 (Monday-Sunday)');
    days.add(n);
  }
  if (!days.size) throw new UserError('pick at least one weekday');
  return [...days].sort((a, b) => a - b);
}

function normalizeTime(raw: unknown): string {
  const t = String(raw ?? '').trim();
  if (!HHMM.test(t)) throw new UserError('time must be HH:MM (24-hour)');
  return t;
}

/** Validate and normalize a schedule from the wire. */
export function normalizeSchedule(raw: unknown): RoutineSchedule {
  const s = (raw ?? {}) as Record<string, unknown>;
  const kind = String(s.kind ?? '');
  if (kind === 'daily') return { kind, time: normalizeTime(s.time) };
  if (kind === 'weekly') return { kind, time: normalizeTime(s.time), weekdays: normalizeWeekdays(s.weekdays) };
  if (kind === 'interval') {
    const every = s.every_minutes;
    if (typeof every !== 'number' || !Number.isInteger(every)) throw new UserError('every_minutes must be a whole number');
    if (every < ROUTINE_MIN_INTERVAL || every > ROUTINE_MAX_INTERVAL)
      throw new UserError(`every_minutes must be between ${ROUTINE_MIN_INTERVAL} and ${ROUTINE_MAX_INTERVAL}`);
    return { kind, every_minutes: every };
  }
  throw new UserError('schedule kind must be daily, weekly or interval');
}

/** Validate the fields a routine is created or updated with. */
export function routineInput(raw: unknown): RoutineInput {
  const src = (raw ?? {}) as Record<string, unknown>;
  const title = String(src.title ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!title) throw new UserError('a routine needs a title');
  if (title.length > ROUTINE_TITLE_MAX) throw new UserError(`routine titles are at most ${ROUTINE_TITLE_MAX} characters`);
  const prompt = String(src.prompt ?? '').trim();
  if (!prompt) throw new UserError('a routine needs instructions to run');
  if (prompt.length > ROUTINE_PROMPT_MAX) throw new UserError(`routine instructions are at most ${ROUTINE_PROMPT_MAX} characters`);
  const channel = String(src.channel_id ?? '').trim();
  return {
    title,
    prompt,
    schedule: normalizeSchedule(src.schedule),
    ...(channel ? { channel_id: channel } : {}),
    enabled: src.enabled === undefined ? true : src.enabled !== false,
  };
}

// ---------------------------------------------------------------------------
// Next run
// ---------------------------------------------------------------------------

function dateToUtcMs(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Local calendar date plus wall-clock minutes -> epoch ms in `tz`. Solved iteratively, then normalized across DST
 * transitions: skipped spring-forward wall times step to the first valid instant at or after the gap on `date`,
 * and ambiguous fall-back wall times pick the first occurrence consistently across positive and negative UTC offsets.
 */
export function zonedWallToUtc(tz: string, date: string, minutes: number): number {
  const target = dateToUtcMs(date, minutes);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(tz, new Date(guess));
    const offset = dateToUtcMs(p.date, p.minutes) - guess;
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  const wallMs = (t: number) => {
    const p = localParts(tz, new Date(t));
    return dateToUtcMs(p.date, p.minutes);
  };
  if (wallMs(guess) === target) {
    // Fall-back overlap: pick the earliest UTC instant that formats to this wall time.
    for (const deltaMin of [120, 90, 60, 45, 30, 20, 15]) {
      const earlier = guess - deltaMin * 60_000;
      if (wallMs(earlier) === target) return earlier;
    }
    return guess;
  }
  // Spring-forward gap: find the first whole minute whose local wall clock is at or past `target`.
  let lo = Math.floor(guess / 60_000);
  let hi = lo;
  for (let i = 0; i < 48 && wallMs(lo * 60_000) >= target; i++) lo -= 60;
  for (let i = 0; i < 48 && wallMs(hi * 60_000) < target; i++) hi += 60;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallMs(mid * 60_000) >= target) hi = mid;
    else lo = mid;
  }
  return hi * 60_000;
}

/**
 * The first run strictly after `fromMs`. Daily and weekly are wall-clock in `timezone`; an interval is a plain
 * duration from `fromMs` (the one case where elapsed time, not the clock, is what the user asked for).
 */
export function nextRun(schedule: RoutineSchedule, fromMs: number, timezone: string): number {
  if (schedule.kind === 'interval') return fromMs + schedule.every_minutes * 60_000;
  const minutes = toMinutes(schedule.time);
  const from = localParts(timezone, new Date(fromMs));
  const days = schedule.kind === 'weekly' ? schedule.weekdays : null;
  for (let add = 0; add <= 7; add++) {
    const date = addDays(from.date, add);
    if (days && !days.includes(weekdayOf(date))) continue;
    const at = zonedWallToUtc(timezone, date, minutes);
    if (at > fromMs) return at;
  }
  // A valid schedule always matches within 7 days; this is the never-in-the-past fallback.
  return zonedWallToUtc(timezone, addDays(from.date, 7), minutes);
}

/** The routine as it must be stored before its task launches: the next run moves past `now` first, so a slow run can't double-fire. */
export function advanceRoutine(r: Routine, now: number, timezone: string): Routine {
  return { ...r, next_run: nextRun(r.schedule, now, timezone) };
}

/** Enabled routines whose next run is at or before `now`. */
export function dueRoutines(all: Routine[], now: number): Routine[] {
  return all.filter((r) => r.enabled && r.next_run != null && r.next_run <= now);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The schedule as a person reads it, for the app and the tests. */
export function scheduleLabel(schedule: RoutineSchedule): string {
  if (schedule.kind === 'interval') {
    const m = schedule.every_minutes;
    if (m % 1440 === 0) return `Every ${m / 1440} day${m === 1440 ? '' : 's'}`;
    if (m % 60 === 0) return `Every ${m / 60} hour${m === 60 ? '' : 's'}`;
    return `Every ${m} minute${m === 1 ? '' : 's'}`;
  }
  const at = `at ${schedule.time}`;
  if (schedule.kind === 'daily') return `Every day ${at}`;
  // Read Monday-first, the way a week is written on a calendar, while 0 stays Sunday in the stored schedule.
  const days = [...schedule.weekdays].sort((a, b) => (a + 6) % 7 - (b + 6) % 7);
  if (days.length === 7) return `Every day ${at}`;
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return `Every weekday ${at}`;
  return `Every ${days.map((d) => WEEKDAY_NAMES[d]).join(', ')} ${at}`;
}
