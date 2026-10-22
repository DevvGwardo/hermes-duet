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
