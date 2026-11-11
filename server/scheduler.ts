import type { Settings } from '../shared/types';
import { items, kv, pages, routines, settings } from './db';
import { briefSlot, hourlySlots, inQuietHours, localParts, toMinutes } from './clock';
import { awayPush, briefCoversHeld, stillWorth, type HeldPush } from './held';
import { notify } from './push';
import { holdBrief, pagesDue } from './pages';
import { pageRefreshing, putRoutine, refreshPage, runBrief, runCheckin, startRoutine } from './runner';
import { advanceRoutine, dueRoutines } from './routines';

const CHECKIN_3X = ['11:00', '14:00', '17:00'];

// When today's due brief started waiting for a page refresh. In memory: a restart only shortens the wait.
let briefHeld: { date: string; since: number } | null = null;

/** Test seam: clear any in-memory brief hold from an earlier tick. */
export function __resetBriefHeld() {
  briefHeld = null;
}

/** Quiet hours are over: replace the pushes they held with one, unless the morning brief is about to cover them. */
function releaseHeld(s: Settings, now: { date: string; minutes: number }, nowMs: number) {
  const held = kv.get<HeldPush[]>('push_held', []);
  if (!held.length || inQuietHours(s, new Date(nowMs))) return;
  kv.set('push_held', []);
  if (briefCoversHeld(s, now, kv.get('brief_last_date', ''))) return;
  const p = awayPush(held, (id) => stillWorth(items.get(id)));
  if (p) notify(p).catch((e) => console.warn('[push]', e));
}

/**
 * Run every enabled routine that is due. The next run is persisted BEFORE the task launches, so a run that takes
 * longer than a tick — or a scheduler that wakes twice — cannot pick the same routine up again. A start that throws
 * still leaves the schedule advanced, with the failure recorded on the routine.
 */
export function runDueRoutines(now = Date.now()) {
  const tz = settings.get().timezone;
  for (const r of dueRoutines(routines.all(), now)) {
    const advanced = routines.save(advanceRoutine(r, now, tz));
    try {
      startRoutine(advanced);
    } catch (e: any) {
      console.error('[routine]', r.id, e?.message ?? e);
      const cur = routines.get(r.id);
      if (cur) putRoutine({ ...cur, last_result: `Couldn't start: ${e?.message ?? e}` });
    }
  }
}

/** One pass of the background scheduler at `nowMs`. Exported for deterministic unit testing. */
export function schedulerTick(nowMs = Date.now()) {
  try {
    const s = settings.get();
    const at = new Date(nowMs);
    const now = localParts(s.timezone, at);
    releaseHeld(s, now, nowMs);

    // Routines are the user's own schedule, so they run even during quiet hours: quiet hours hold pushes, not work.
    runDueRoutines(nowMs);

    // Standing pages rebuild 30 minutes before the brief (whether or not the brief is on), each once a day.
    for (const p of pagesDue(pages.all(), now, s.brief_time, pageRefreshing)) refreshPage(p, now.date);

    const held = briefHeld?.date === now.date ? briefHeld.since : null;
    const brief = briefSlot(s, now, kv.get('brief_last_date', ''), held !== null);
    if (brief === 'due') {
      // A page refresh still running (it ran long, or a late wake started it this same tick) holds the brief for
      // up to BRIEF_HOLD_MIN, so the brief reports what changed instead of "still refreshing".
      if (holdBrief(pages.all().some(pageRefreshing), held, nowMs)) {
        if (held === null) briefHeld = { date: now.date, since: nowMs };
        return;
      }
      briefHeld = null;
      kv.set('brief_last_date', now.date);
      runBrief('scheduled');
      return;
    }

    if (s.checkins === 'off' || inQuietHours(s, at)) return;
    // Don't check in before today's brief has gone out. A brief missed for the day (the Mac slept past midday)
    // doesn't hold them back, or a late wake would silence the whole day.
    if (brief === 'early') return;
    const slots = s.checkins === '3x' ? CHECKIN_3X : hourlySlots(s.quiet_end, s.quiet_start);
    const last = kv.get('checkin_last_slot', '');
    const slot = [...slots].reverse().find((t) => toMinutes(t) <= now.minutes && now.minutes - toMinutes(t) < 50);
    if (slot && last !== `${now.date} ${slot}`) {
      kv.set('checkin_last_slot', `${now.date} ${slot}`);
      runCheckin();
    }
  } catch (e) {
    console.error('[scheduler]', e);
  }
}

/** Fires standing-page refreshes, the morning brief, check-ins and user-defined routines. Missed slots (Mac asleep) catch up once, within limits. */
export function startScheduler() {
  if (process.env.DUET_DISABLE_SCHEDULER) return; // demo instances never call Hermes on their own
  setInterval(() => schedulerTick(), 30_000);
  setTimeout(() => schedulerTick(), 5_000);
}
