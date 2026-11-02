import { expect, test } from 'bun:test';
import { channels, db, kv, newId } from './db';

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

test('creating a name that is already a live channel does not erase its topic', () => {
  const first = channels.create({ name: 'hc-live', topic: 'still here' });
  const again = channels.create({ name: 'hc-live' });
  expect(again.id).toBe(first.id);
  expect(again.topic).toBe('still here');
});

test('an archived channel comes back under the same id, with the new topic', () => {
  const first = channels.create({ name: 'hc-arch', topic: 'old topic' });
  channels.archive(first.id);
  const back = channels.create({ name: 'hc-arch', topic: 'new topic' });
  expect(back.id).toBe(first.id);
  expect(back.topic).toBe('new topic');
  expect(back.archived_at ?? null).toBe(null);
});

test('reusing an archived channel without a topic keeps the one it had', () => {
  const first = channels.create({ name: 'hc-arch2', topic: 'kept' });
  channels.archive(first.id);
  expect(channels.create({ name: 'hc-arch2' }).topic).toBe('kept');
});
