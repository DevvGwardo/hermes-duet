import type { Settings } from '../shared/types';
import { items, kv, pages, settings } from './db';
import { hourlySlots, inQuietHours, localParts, toMinutes } from './clock';
import { awayPush, briefCoversHeld, stillWorth, type HeldPush } from './held';
import { notify } from './push';
import { holdBrief, pagesDue } from './pages';
import { pageRefreshing, refreshPage, runBrief, runCheckin } from './runner';

const CHECKIN_3X = ['11:00', '14:00', '17:00'];

// When today's due brief started waiting for a page refresh. In memory: a restart only shortens the wait.
let briefHeld: { date: string; since: number } | null = null;

/** Quiet hours are over: replace the pushes they held with one, unless the morning brief is about to cover them. */
function releaseHeld(s: Settings, now: { date: string; minutes: number }) {
  const held = kv.get<HeldPush[]>('push_held', []);
  if (!held.length || inQuietHours(s)) return;
  kv.set('push_held', []);
  if (briefCoversHeld(s, now, kv.get('brief_last_date', ''))) return;
  const p = awayPush(held, (id) => stillWorth(items.get(id)));
  if (p) notify(p).catch((e) => console.warn('[push]', e));
}

/** Fires standing-page refreshes, the morning brief and check-ins. Missed slots (Mac asleep) catch up once, within limits. */
export function startScheduler() {
  if (process.env.DUET_DISABLE_SCHEDULER) return; // demo instances never call Hermes on their own
  const tick = () => {
    try {
      const s = settings.get();
      const now = localParts(s.timezone);
      releaseHeld(s, now);

      // Standing pages rebuild 30 minutes before the brief (whether or not the brief is on), each once a day.
      for (const p of pagesDue(pages.all(), now, s.brief_time, pageRefreshing)) refreshPage(p, now.date);

      if (s.brief_enabled && kv.get('brief_last_date', '') !== now.date) {
        const due = toMinutes(s.brief_time);
        const held = briefHeld?.date === now.date ? briefHeld.since : null;
        // Catch up if the Mac woke late, but not after midday: a 3 PM "morning brief" is noise. A brief already
        // waiting on a refresh still goes out when the wait ends.
        if (now.minutes >= due && (now.minutes < Math.max(due + 1, 12 * 60) || held !== null)) {
          // A page refresh still running (it ran long, or a late wake started it this same tick) holds the brief for
          // up to BRIEF_HOLD_MIN, so the brief reports what changed instead of "still refreshing".
          if (holdBrief(pages.all().some(pageRefreshing), held, Date.now())) {
            if (held === null) briefHeld = { date: now.date, since: Date.now() };
            return;
          }
          briefHeld = null;
          kv.set('brief_last_date', now.date);
          runBrief('scheduled');
          return;
        }
      }

      if (s.checkins === 'off' || inQuietHours(s)) return;
      // Don't check in before today's brief has gone out.
      if (s.brief_enabled && kv.get('brief_last_date', '') !== now.date) return;
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
  };
  setInterval(tick, 30_000);
  setTimeout(tick, 5_000);
}
