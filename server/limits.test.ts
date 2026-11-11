import { expect, test } from 'bun:test';
import {
  SlidingWindow,
  idempotencyKey,
  idempotentInflight,
  idempotentItem,
  rememberIdempotent,
  resetIdempotency,
  startIdempotentInflight,
} from './limits';

test('a sliding window allows the budget and refuses the next hit', () => {
  const w = new SlidingWindow(3, 1000);
  const t = 10_000;
  expect(w.check('device', t).allowed).toBe(true);
  expect(w.check('device', t + 10).allowed).toBe(true);
  expect(w.check('device', t + 20).allowed).toBe(true);
  const refused = w.check('device', t + 30);
  expect(refused.allowed).toBe(false);
  expect(refused.retryAfterMs).toBe(970);
});

test('the window is per key and expires', () => {
  const w = new SlidingWindow(1, 1000);
  expect(w.check('a', 1000).allowed).toBe(true);
  expect(w.check('b', 1000).allowed).toBe(true);
  expect(w.check('a', 1500).allowed).toBe(false);
  expect(w.check('a', 2001).allowed).toBe(true);
});

test('the idempotency key is optional, validated, and bounded', () => {
  const req = (value?: string) =>
    new Request('http://127.0.0.1:7456/api/messages', { headers: value === undefined ? {} : { 'idempotency-key': value } });
  expect(idempotencyKey(req())).toBe(null);
  expect(idempotencyKey(req('order-12345'))).toBe('order-12345');
  expect(() => idempotencyKey(req('short'))).toThrow('invalid idempotency key');
  expect(() => idempotencyKey(req('has spaces here'))).toThrow('invalid idempotency key');
});

test('a remembered key returns its item until it expires', () => {
  resetIdempotency();
  rememberIdempotent('device:key', 'item-1', 1000);
  expect(idempotentItem('device:key', 1000)).toBe('item-1');
  expect(idempotentItem('other:key', 1000)).toBe(null);
  expect(idempotentItem('device:key', 1000 + 10 * 60_000 + 1)).toBe(null);
});

test('in-flight idempotency coordinates concurrent requests until resolved or reset', async () => {
  resetIdempotency();
  expect(idempotentInflight('device:k1')).toBeNull();
  const finish = startIdempotentInflight('device:k1');
  const pending = idempotentInflight('device:k1');
  expect(pending).not.toBeNull();
  finish('item-99');
  expect(await pending!).toBe('item-99');
  expect(idempotentInflight('device:k1')).toBeNull();

  const finish2 = startIdempotentInflight('device:k2');
  const pending2 = idempotentInflight('device:k2');
  resetIdempotency();
  expect(await pending2!).toBeNull();
  finish2('late');
  expect(idempotentInflight('device:k2')).toBeNull();
});

test('rememberIdempotent evicts stale or oldest entries when full and SlidingWindow prunes past 2048 keys', () => {
  resetIdempotency();
  for (let i = 0; i < 520; i++) rememberIdempotent(`dev:k-${i}`, `item-${i}`, 10_000 + i);
  expect(idempotentItem('dev:k-0', 10_600)).toBeNull();
  expect(idempotentItem('dev:k-519', 10_600)).toBe('item-519');

  const w = new SlidingWindow(2, 1000);
  for (let i = 0; i < 2050; i++) {
    expect(w.check(`k-${i}`, 1000).allowed).toBe(true);
  }
  expect(w.check('k-0', 5000).allowed).toBe(true);
});
