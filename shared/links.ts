// Which card a push or link points at. Pushes name it two ways: `card_id` (questions, approvals, interrupted work)
// or only the `?card=` in their URL (briefs, task handovers). Dependency-free so the server's held pushes and the
// web app's notification taps read both the same way.
import type { Item } from './types';

export function cardOf(p: { card_id?: string | null; url?: string | null }): string | null {
  return p.card_id || p.url?.match(/[?&]card=([^&#]+)/)?.[1] || null;
}

/** A question or approval that no longer waits on the user: approved, declined, answered or expired. */
export function isSettledAsk(item: Item | undefined): boolean {
  const c = item?.kind === 'card' ? item.card : undefined;
  return !!c && (c.type === 'approval' || c.type === 'choice') && c.status !== 'pending';
}

/**
 * Shown notifications to close because the card they ask about is settled (in the app, on another device, by a
 * redraft that replaced it, or because its run ended); otherwise "Needs your OK" stays on the lock screen after the
 * decision, and its Approve button fails silently. Briefs, handovers and "Heads up" notes never wait on anyone, so
 * their banners stay. A card this device hasn't loaded is left alone: nothing says it was decided.
 */
export function settledNotifications<N extends { data?: any }>(notes: N[], card: (id: string) => Item | undefined): N[] {
  return notes.filter((n) => {
    const id = n.data ? cardOf(n.data) : null;
    return !!id && isSettledAsk(card(id));
  });
}
