import { describe, expect, test } from 'bun:test';
import { cardOf } from '../shared/links';
import type { Item, Settings } from '../shared/types';
import { awayPush, briefCoversHeld, holdPush, stillWorth } from './held';

const s: Settings = { brief_enabled: true, brief_time: '07:30', checkins: 'off', quiet_start: '21:30', quiet_end: '07:00', timezone: 'America/New_York' };
const card = (status: string, type = 'question') => ({ id: 'c', card: { type, title: 't', status } }) as unknown as Item;

describe('held pushes', () => {
  test('cardOf reads card_id or the ?card= in the url', () => {
    expect(cardOf({ card_id: 'a' })).toBe('a');
    expect(cardOf({ url: '/?card=b' })).toBe('b');
    expect(cardOf({ url: '/' })).toBeNull();
    // A notification tap hands the app the absolute URL with a null card_id (brief and handover pushes).
    expect(cardOf({ card_id: null, url: 'https://duet.example/?card=h1' })).toBe('h1');
    // Cold start reads location.search.
    expect(cardOf({ url: '?card=b2&x=1' })).toBe('b2');
  });

  test('holdPush keeps card pushes only, one per card, newest wins', () => {
    let h = holdPush([], { title: 'Quick question', body: 'Book Friday?', card_id: 'q1' }, 1);
    h = holdPush(h, { title: 'Agent says hi', body: 'x', tag: 'agent' }, 2);
    h = holdPush(h, { title: 'Done: Report', body: 'All 12 rows', url: '/?card=h1' }, 3);
    h = holdPush(h, { title: 'Quick question', body: 'Book Saturday?', card_id: 'q1' }, 4);
    expect(h.map((x) => [x.card_id, x.line])).toEqual([
      ['h1', 'Done: Report'],
      ['q1', 'Quick question: Book Saturday?'],
    ]);
  });

  test('stillWorth: pending cards and handovers only', () => {
    expect(stillWorth(card('pending'))).toBe(true);
    expect(stillWorth(card('answered'))).toBe(false);
    expect(stillWorth(card('info', 'handover'))).toBe(true);
    expect(stillWorth(card('info', 'brief'))).toBe(false);
    expect(stillWorth(null)).toBe(false);
  });

  test('awayPush: one push for what is still worth it, oldest first, capped', () => {
    expect(awayPush([{ card_id: 'a', line: 'A', at: 1 }], () => false)).toBeNull();
    const one = awayPush([{ card_id: 'a', line: 'A', at: 1 }, { card_id: 'b', line: 'B', at: 2 }], (id) => id === 'b')!;
    expect(one).toMatchObject({ title: 'While you were away', body: 'B', card_id: 'b', url: '/?card=b', tag: 'away' });
    const held = ['e', 'd', 'c', 'b', 'a'].map((id, i) => ({ card_id: id, line: id.toUpperCase(), at: 10 - i }));
    const many = awayPush(held, () => true)!;
    expect(many.body).toBe('A\nB\nC\n+2 more');
    expect(many.card_id).toBeUndefined();
    expect(many.url).toBe('/');
  });

  test('briefCoversHeld when the brief is due within the hour and not sent', () => {
    const d = '2026-10-22';
    expect(briefCoversHeld(s, { date: d, minutes: 7 * 60 }, '2026-10-21')).toBe(true);
    expect(briefCoversHeld(s, { date: d, minutes: 6 * 60 }, '2026-10-21')).toBe(false);
    expect(briefCoversHeld(s, { date: d, minutes: 8 * 60 }, '2026-10-21')).toBe(true); // late wake, brief catching up
    expect(briefCoversHeld(s, { date: d, minutes: 7 * 60 }, d)).toBe(false); // brief already went out
    expect(briefCoversHeld(s, { date: d, minutes: 13 * 60 }, '2026-10-21')).toBe(false); // too late for a brief
    expect(briefCoversHeld({ ...s, brief_enabled: false }, { date: d, minutes: 7 * 60 }, '2026-10-21')).toBe(false);
  });
});
