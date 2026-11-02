import { expect, test } from 'bun:test';
import { channels, db, files, kv, newId, pages } from './db';
import { search } from './search';

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

// The search index is a second copy of a file's title, so every write has to move both. A rename that reached the
// row but not the index keeps the old title findable; an update for a file that isn't there puts a hit in search
// that opens a 404 in Make. Both are one unit of work, not two.
test('renaming a delivered file re-indexes it under the new title only', () => {
  const entry = { id: newId(), title: 'Statement alpha', name: 'statement.pdf', mime: 'application/pdf', size: 12, created_at: Date.now() };
  files.add(entry, '/tmp/hc-statement.pdf');
  files.update({ ...entry, title: 'Statement beta' });
  const hits = (q: string) => search(db, q).filter((h) => h.id === entry.id);
  expect(hits('beta')).toHaveLength(1);
  expect(hits('alpha')).toHaveLength(0);
});

test('updating a file the library does not have leaves no searchable ghost', () => {
  files.update({ id: 'hc-no-such-file', title: 'Ghost statement', name: 'ghost.pdf', mime: 'application/pdf', size: 1, created_at: Date.now() });
  expect(search(db, 'ghost').some((h) => h.id === 'hc-no-such-file')).toBe(false);
});

test('removing a page takes its search row with it', () => {
  const page = pages.save({ id: newId(), title: 'Retirement plan', instructions: 'Rebuild it.', file_id: 'f-hc', created_at: Date.now(), updated_at: Date.now() });
  expect(search(db, 'retirement').some((h) => h.id === page.id)).toBe(true);
  pages.remove(page.id);
  expect(search(db, 'retirement').some((h) => h.id === page.id)).toBe(false);
});
