import type { Settings } from '../shared/types';

/** Wall-clock parts in the user's timezone. */
export function localParts(tz: string, at = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${p.hour}:${p.minute}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: p.weekday as string,
  };
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function inQuietHours(s: Settings, at = new Date()) {
  const now = localParts(s.timezone, at).minutes;
  const start = toMinutes(s.quiet_start);
  const end = toMinutes(s.quiet_end);
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** off: briefs disabled · sent: today's already ran · early: not due yet · due: run it now · missed: too late today. */
export type BriefSlot = 'off' | 'sent' | 'early' | 'due' | 'missed';

/**
 * Where today's scheduled morning brief stands. A late wake (Mac asleep) still catches it up, but not after midday,
 * because a 3 PM "morning brief" is noise; a brief already held for a page refresh stays due until the hold ends.
 * Past that the day's brief is missed, which must not block the rest of the day the way a pending one does.
 */
export function briefSlot(s: Settings, now: { date: string; minutes: number }, lastDate: string, held = false): BriefSlot {
  if (!s.brief_enabled) return 'off';
  if (lastDate === now.date) return 'sent';
  const due = toMinutes(s.brief_time);
  if (now.minutes < due) return 'early';
  return now.minutes < Math.max(due + 1, 12 * 60) || held ? 'due' : 'missed';
}

export function friendlyNow(tz: string) {
  return new Date().toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** On-the-hour check-in slots from the end of quiet hours to the start of the next quiet period. */
export function hourlySlots(from: string, to: string) {
  const start = Math.ceil(toMinutes(from) / 60);
  // Include every hour that starts before quiet time (quiet at 21:30 still allows 21:00).
  const end = Math.ceil(toMinutes(to) / 60);
  const out: string[] = [];
  for (let h = start; h < (end <= start ? end + 24 : end); h++) out.push(`${String(h % 24).padStart(2, '0')}:00`);
  return out.sort();
}
