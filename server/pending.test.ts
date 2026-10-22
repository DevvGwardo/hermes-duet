import { describe, expect, test } from 'bun:test';
import { isPendingCard, trackPending } from '../shared/pending';
import type { CardStatus, Item } from '../shared/types';

const card = (id: string, created_at: number, status: CardStatus = 'pending'): Item => ({
  id,
  kind: 'card',
  created_at,
  updated_at: created_at,
  card: { type: 'approval', title: id, status },
});

describe('the needs-you list follows item events, not the loaded page', () => {
  test('only pending cards count', () => {
    expect(isPendingCard(card('a', 1))).toBe(true);
    expect(isPendingCard(card('a', 1, 'approved'))).toBe(false);
    expect(isPendingCard({ id: 'm', kind: 'assistant', created_at: 1, updated_at: 1, text: 'pending' })).toBe(false);
  });

  test('a new pending card joins in created order', () => {
    const list = trackPending([card('old', 1), card('new', 3)], card('mid', 2));
    expect(list.map((c) => c.id)).toEqual(['old', 'mid', 'new']);
  });

  test('a decided card leaves the list even if it was never in the loaded page', () => {
    const list = trackPending([card('ancient', 1), card('b', 5)], card('ancient', 1, 'approved'));
    expect(list.map((c) => c.id)).toEqual(['b']);
  });

  test('an update to a still-pending card replaces it in place', () => {
    const list = trackPending([card('a', 1)], { ...card('a', 1), card: { type: 'approval', title: 'edited', status: 'pending' } });
    expect(list).toHaveLength(1);
    expect(list[0].card?.title).toBe('edited');
  });

  test('unrelated items leave the list untouched', () => {
    const before = [card('a', 1)];
    expect(trackPending(before, { id: 'm', kind: 'user', created_at: 2, updated_at: 2, text: 'hi' })).toBe(before);
  });
});
