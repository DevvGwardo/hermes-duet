import { describe, expect, test } from 'bun:test';
import { cardOf, isSettledAsk, settledNotifications } from '../shared/links';
import type { CardData, Item } from '../shared/types';

const card = (id: string, type: CardData['type'], status: CardData['status']) =>
  ({ id, kind: 'card', created_at: 1, updated_at: 1, card: { type, title: id, status } }) as Item;

describe('settledNotifications', () => {
  const cards = new Map(
    [
      card('approved', 'approval', 'approved'),
      card('declined', 'approval', 'declined'),
      card('answered', 'choice', 'answered'),
      card('replaced', 'choice', 'expired'),
      card('waiting', 'approval', 'pending'),
      card('brief', 'brief', 'info'),
      card('handover', 'handover', 'info'),
      card('heads-up', 'note', 'info'),
    ].map((c) => [c.id, c]),
  );
  const notes = (...data: any[]) => data.map((d, i) => ({ i, data: d }));

  test('closes banners for settled approvals and questions only', () => {
    const shown = notes(
      { card_id: 'approved', url: '/?card=approved' },
      { card_id: 'declined' },
      { card_id: 'answered' },
      { card_id: 'replaced' },
      { card_id: 'waiting' },
      // Brief and handover pushes name their card only in the URL; they never wait on anyone, so they stay.
      { card_id: null, url: 'https://duet.example/?card=brief' },
      { card_id: null, url: '/?card=handover' },
      { card_id: 'heads-up' },
    );
    expect(settledNotifications(shown, (id) => cards.get(id)).map((n) => n.data.card_id)).toEqual(['approved', 'declined', 'answered', 'replaced']);
  });

  test('leaves alone what it cannot tie to a known card', () => {
    const shown = notes({ card_id: 'not-loaded' }, { url: '/' }, undefined, { card_id: null, url: null });
    expect(settledNotifications(shown, (id) => cards.get(id))).toEqual([]);
  });

  test('reads a settled card linked only by URL (an older push without card_id)', () => {
    expect(settledNotifications(notes({ url: '/?card=answered' }), (id) => cards.get(id))).toHaveLength(1);
  });
});

describe('cardOf', () => {
  test('prefers card_id and falls back to the ?card= param', () => {
    expect(cardOf({ card_id: 'a', url: '/?card=b' })).toBe('a');
    expect(cardOf({ url: 'https://duet.example/?card=brief' })).toBe('brief');
    expect(cardOf({ url: '/?x=1&card=q2#frag' })).toBe('q2');
  });

  test('yields null when no card is named', () => {
    expect(cardOf({})).toBeNull();
    expect(cardOf({ card_id: null, url: null })).toBeNull();
    expect(cardOf({ url: '/?x=1' })).toBeNull();
  });
});

describe('isSettledAsk', () => {
  test('pending approvals and questions still wait on the user', () => {
    expect(isSettledAsk(card('a', 'approval', 'pending'))).toBe(false);
    expect(isSettledAsk(card('q', 'choice', 'pending'))).toBe(false);
  });

  test('decided asks are settled; notes and briefs never are', () => {
    expect(isSettledAsk(card('a', 'approval', 'approved'))).toBe(true);
    expect(isSettledAsk(card('d', 'approval', 'declined'))).toBe(true);
    expect(isSettledAsk(card('q', 'choice', 'answered'))).toBe(true);
    expect(isSettledAsk(card('x', 'choice', 'expired'))).toBe(true);
    expect(isSettledAsk(card('n', 'note', 'info'))).toBe(false);
    expect(isSettledAsk(card('b', 'brief', 'info'))).toBe(false);
    expect(isSettledAsk(undefined)).toBe(false);
  });
});
