import { describe, expect, test } from 'bun:test';
import { isSettledAsk, settledNotifications } from './links';
import type { CardData, Item } from './types';

const card = (id: string, type: CardData['type'], status: CardData['status']) =>
  ({ id, kind: 'card', created_at: 1, updated_at: 1, card: { type, title: id, status } }) as Item;

describe('shared/links payment asks', () => {
  test('isSettledAsk treats pending payment as open and approved/declined/expired payment as settled', () => {
    expect(isSettledAsk(card('p-pending', 'payment', 'pending'))).toBe(false);
    expect(isSettledAsk(card('p-approved', 'payment', 'approved'))).toBe(true);
    expect(isSettledAsk(card('p-declined', 'payment', 'declined'))).toBe(true);
    expect(isSettledAsk(card('p-expired', 'payment', 'expired'))).toBe(true);
  });

  test('settledNotifications closes banners for settled payments while leaving pending payments open', () => {
    const cards = new Map(
      [
        card('paid', 'payment', 'approved'),
        card('pay-declined', 'payment', 'declined'),
        card('pay-waiting', 'payment', 'pending'),
      ].map((c) => [c.id, c]),
    );
    const shown = [
      { i: 0, data: { card_id: 'paid' } },
      { i: 1, data: { card_id: 'pay-declined' } },
      { i: 2, data: { card_id: 'pay-waiting' } },
    ];
    expect(settledNotifications(shown, (id) => cards.get(id)).map((n) => n.data.card_id)).toEqual([
      'paid',
      'pay-declined',
    ]);
  });
});
