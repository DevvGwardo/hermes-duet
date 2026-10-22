// How old a waiting approval or question is, in words, once it is old enough to matter. A draft written yesterday
// can still say "tomorrow", and the errand may have been handled since; the card and the agent's resume prompt both
// say when it was written so nobody acts on it as if it were fresh. Dependency-free so the server and web share it.

/** Past this, or across a local midnight, a waiting card counts as old. */
export const OLD_ASK_MS = 6 * 3600_000;

/** Local calendar date ("YYYY-MM-DD") of `at` in `tz`. */
function localDate(at: number, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * When a card was posted ("yesterday at 9:14 PM"), or null while it is still fresh: the same local day and under
 * `OLD_ASK_MS`. Midnight counts on its own because that is when "today" and "tomorrow" in a draft stop being true.
 */
export function askAge(createdAt: number, now: number, tz?: string): string | null {
  const then = localDate(createdAt, tz);
  const today = localDate(now, tz);
  if (then === today && now - createdAt < OLD_ASK_MS) return null;
  const time = new Date(createdAt).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${then}T00:00:00Z`)) / 86400_000);
  if (days <= 0) return `earlier today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const day = new Date(createdAt).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  return `on ${day} at ${time}`;
}
