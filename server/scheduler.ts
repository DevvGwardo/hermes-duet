import { kv, settings } from './db';
import { hourlySlots, inQuietHours, localParts, toMinutes } from './clock';
import { runBrief, runCheckin } from './runner';

const CHECKIN_3X = ['11:00', '14:00', '17:00'];

/** Fires the morning brief and check-ins. Missed slots (Mac asleep) catch up once, within limits. */
export function startScheduler() {
  if (process.env.DUET_DISABLE_SCHEDULER) return; // demo instances never call Hermes on their own
  const tick = () => {
    try {
      const s = settings.get();
      const now = localParts(s.timezone);

      if (s.brief_enabled && kv.get('brief_last_date', '') !== now.date) {
        const due = toMinutes(s.brief_time);
        // Catch up if the Mac woke late, but not after midday: a 3 PM "morning brief" is noise.
        if (now.minutes >= due && now.minutes < Math.max(due + 1, 12 * 60)) {
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
