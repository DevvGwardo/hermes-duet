import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { applySchema } from './schema';
import { ftsQuery, search } from './search';

function seeded(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  const insert = db.query('INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('a', 'user', 1000, 1000, 'chan-general', JSON.stringify({ text: 'Can you pay the rent before Friday?' }));
  insert.run('b', 'assistant', 2000, 2000, 'chan-general', JSON.stringify({ text: 'The rent payment went out this morning.' }));
  insert.run('c', 'card', 3000, 3000, 'chan-finances', JSON.stringify({ card: { type: 'note', title: 'Tax documents', body: 'The accountant needs the rent receipts.' } }));
  db.query('INSERT INTO fts_assets(ref_id, kind, title, body) VALUES (?, ?, ?, ?)').run('t1', 'task', 'Rent analysis', 'Compare three years of rent and deposits');
  db.query('INSERT INTO fts_assets(ref_id, kind, title, body) VALUES (?, ?, ?, ?)').run('f1', 'file', 'March statement', 'bank statement pdf');
  return db;
}

describe('ftsQuery', () => {
  test('quotes every word as a prefix term', () => {
    expect(ftsQuery('rent')).toEqual({ match: '"rent"*', terms: ['rent'] });
    expect(ftsQuery('rent Friday')).toEqual({ match: '"rent"* AND "friday"*', terms: ['rent', 'friday'] });
  });

  test('treats FTS operators as words instead of syntax', () => {
    expect(ftsQuery('rent AND NOT due')).toEqual({ match: '"rent"* AND "and"* AND "not"* AND "due"*', terms: ['rent', 'and', 'not', 'due'] });
    expect(ftsQuery('"rent*')).toEqual({ match: '"rent"*', terms: ['rent'] });
    expect(ftsQuery('NEAR(rent deposit)')).toEqual({ match: '"near"* AND "rent"* AND "deposit"*', terms: ['near', 'rent', 'deposit'] });
  });

  test('dedupes terms and caps how many it uses', () => {
    expect(ftsQuery('rent rent RENT')).toEqual({ match: '"rent"*', terms: ['rent'] });
    const many = ftsQuery('a b c d e f g h i j');
    expect(many?.terms).toHaveLength(8);
  });

  test('nothing searchable is null, not an empty query', () => {
    expect(ftsQuery('')).toBeNull();
    expect(ftsQuery('   !!!   ')).toBeNull();
    expect(ftsQuery('* " - :')).toBeNull();
  });

  test('keeps unicode words', () => {
    expect(ftsQuery('café')).toEqual({ match: '"café"*', terms: ['café'] });
  });

  test('caps a very long query', () => {
    const q = ftsQuery('rent '.repeat(500));
    expect(q?.terms).toEqual(['rent']);
  });
});

describe('search', () => {
  test('finds messages, cards, tasks and files', () => {
    const db = seeded();
    const hits = search(db, 'rent');
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b', 'c', 't1']);
    expect(hits.some((h) => h.kind === 'task' && h.title === 'Rent analysis')).toBe(true);
    // A file with "statement" is not a rent hit.
    expect(hits.some((h) => h.id === 'f1')).toBe(false);
  });

  test('returns the channel and an excerpt with the match in it', () => {
    const db = seeded();
    const card = search(db, 'accountant')[0];
    expect(card.channel_id).toBe('chan-finances');
    expect(card.snippet.toLowerCase()).toContain('accountant');
    expect(card.title).toBe('Tax documents');
  });

  test('a title-only match still has a usable snippet and title', () => {
    const db = seeded();
    const hit = search(db, 'march')[0];
    expect(hit.kind).toBe('file');
    expect(hit.title).toBe('March statement');
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  test('respects the limit and returns nothing for an empty query', () => {
    const db = seeded();
    expect(search(db, 'rent', 1).length).toBe(1);
    expect(search(db, '')).toEqual([]);
  });

  test('prefix matching finds words as they are typed', () => {
    const db = seeded();
    expect(search(db, 'paym').map((h) => h.id)).toContain('b');
  });
});