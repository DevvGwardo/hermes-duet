import { expect, test } from 'bun:test';
import { hasSubscriptions, saveSubscription } from './push';

test('saveSubscription rejects malformed subscriptions before touching the db', () => {
  expect(() => saveSubscription(null, 'd1')).toThrow('bad subscription');
  expect(() => saveSubscription({}, 'd1')).toThrow('bad subscription');
  expect(() => saveSubscription({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } }, 'd1')).toThrow('bad endpoint');
  expect(() => saveSubscription({ endpoint: 'https://x', keys: { p256dh: 'a' } }, 'd1')).toThrow('bad subscription');
});

test('fresh test db starts with no push subscriptions', () => {
  expect(hasSubscriptions()).toBe(false);
  expect(hasSubscriptions('no-such-device')).toBe(false);
});

test('saveSubscription stores a well-formed subscription and reports it', () => {
  saveSubscription({ endpoint: 'https://push.example/sub-1', keys: { p256dh: 'k1', auth: 'a1' } }, 'dev-1');
  expect(hasSubscriptions()).toBe(true);
  expect(hasSubscriptions('dev-1')).toBe(true);
  expect(hasSubscriptions('other-device')).toBe(false);
});
