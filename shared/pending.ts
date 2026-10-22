// The "needs you" set: every card still waiting on the user, independent of how much of the
// thread is loaded. Dependency-free so the web store and tests share one definition.
import type { Item } from './types';

export function isPendingCard(item: Item): boolean {
  return item.kind === 'card' && item.card?.status === 'pending';
}

/** Fold one item event into the pending list: add or refresh it while pending, drop it once decided. */
export function trackPending(pending: Item[], item: Item): Item[] {
  const rest = pending.filter((p) => p.id !== item.id);
  if (!isPendingCard(item)) return rest.length === pending.length ? pending : rest;
  return [...rest, item].sort((a, b) => a.created_at - b.created_at);
}
