// Pushes that quiet hours suppressed, held so they come back as one "While you were away" push instead of being
// lost. Pure rules, kept out of push.ts and scheduler.ts so they can be tested without web-push or a database.
import { cardOf } from '../shared/links';
import type { Item, Settings } from '../shared/types';
import type { PushPayload } from './push';
import { briefSlot, toMinutes } from './clock';

export interface HeldPush {
  card_id: string;
  /** What the push would have said, on one line ("Quick question: …", "Done: …"). */
  line: string;
  at: number;
}

const MAX_HELD = 20;
const MAX_LINES = 3;

/**
 * Add a suppressed push to the held list. Only pushes about a card are held (an agent `notify` posts one), so a
 * bare chat-reply push is dropped. A newer push about the same card replaces the older one.
 */
export function holdPush(held: HeldPush[], p: PushPayload, now: number): HeldPush[] {
  const card_id = cardOf(p);
  if (!card_id) return held;
  const line = (p.title.includes(':') || !p.body ? p.title : `${p.title}: ${p.body}`).slice(0, 120);
  return [...held.filter((h) => h.card_id !== card_id), { card_id, line, at: now }].slice(-MAX_HELD);
}

/**
 * Whether a held push still deserves to reach the user: its card is still waiting on them, it is a finished
 * task's handover (shared when done, so it is news even though it never waits on anyone), or it is an agent
 * `notify` (the agent judged it needs them soon).
 */
export function stillWorth(item: Item | null): boolean {
  return !!item?.card && (item.card.status === 'pending' || item.card.type === 'handover' || !!item.card.alert);
}

/** The one push that replaces everything held, or null when nothing held is still worth it. */
export function awayPush(held: HeldPush[], worth: (cardId: string) => boolean): PushPayload | null {
  const keep = held.filter((h) => worth(h.card_id)).sort((a, b) => a.at - b.at);
  if (!keep.length) return null;
  const more = keep.length - MAX_LINES;
  const body = keep.slice(0, MAX_LINES).map((h) => h.line).join('\n') + (more > 0 ? `\n+${more} more` : '');
  const one = keep.length === 1 ? keep[0].card_id : null;
  return { title: 'While you were away', body, tag: 'away', url: one ? `/?card=${one}` : '/', ...(one && { card_id: one }) };
}

/**
 * The morning brief goes out within the hour (or is due and still catching up), so it covers what was held: the
 * brief prompt already lists every pending card, and a second push minutes before it is noise.
 */
export function briefCoversHeld(s: Settings, now: { date: string; minutes: number }, briefLastDate: string): boolean {
  // Same rule the scheduler uses, so a brief missed for the day (too late to catch up) covers nothing.
  const slot = briefSlot(s, now, briefLastDate);
  return slot === 'due' || (slot === 'early' && now.minutes >= toMinutes(s.brief_time) - 60);
}
