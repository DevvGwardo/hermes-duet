import { expect, test } from 'bun:test';
import { db, kv, newId } from './db';

test('new ids are compact, sortable and unique', () => {
  const a = newId();
  const b = newId();
  expect(a).toMatch(/^[0-9a-z]{15}$/);
  expect(b).toMatch(/^[0-9a-z]{15}$/);
  expect(a).not.toBe(b);
  expect(b >= a).toBe(true);
  expect(new Set(Array.from({ length: 100 }, newId)).size).toBe(100);
});

test('kv returns the fallback for missing keys', () => {
  expect(kv.get('hc-missing-key', 'fb')).toBe('fb');
  expect(kv.get<number>('hc-missing-num', 7)).toBe(7);
});

test('kv round-trips objects', () => {
  kv.set('hc-obj', { a: 1, b: ['x'] });
  expect(kv.get<{ a: number; b: string[] } | null>('hc-obj', null)).toEqual({ a: 1, b: ['x'] });
});

test('kv survives a corrupt value instead of throwing', () => {
  db.query('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'hc-corrupt',
    'not-json{{{',
  );
  expect(kv.get('hc-corrupt', 'fb')).toBe('fb');
});
