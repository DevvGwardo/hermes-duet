import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { Item } from '../shared/types';
import { indexItem } from './search';
import { GENERAL_CHANNEL, SCHEMA_VERSION, applySchema, backfillAssets, backfillItems } from './schema';

function fresh(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

/** Insert an item the way a test does, then index it the way db.items.save does. */
const insert = (db: Database, item: Item) => {
  db.query('INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)').run(
    item.id,
    item.kind,
    item.created_at,
    item.updated_at,
    item.channel_id ?? GENERAL_CHANNEL,
    JSON.stringify(item),
  );
  indexItem(db, item, item.channel_id ?? GENERAL_CHANNEL);
};

const put = (db: Database, id: string, json: Partial<Item>, channel?: string) =>
  insert(db, { id, kind: 'user', created_at: 1, updated_at: 1, channel_id: channel ?? GENERAL_CHANNEL, ...json } as Item);

describe('schema', () => {
  test('adds the v2 tables and columns without touching an existing items table', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, run_id TEXT, task_id TEXT, json TEXT NOT NULL)');
    db.query('INSERT INTO items(id, kind, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?)').run('old', 'user', 1, 1, '{"text":"hello"}');
    applySchema(db);
    const cols = db.query<{ name: string }, []>('PRAGMA table_info(items)').all().map((c) => c.name);
    expect(cols).toContain('channel_id');
    // The old row defaults into the general channel and is indexed on the way in.
    expect(db.query<{ channel_id: string }, [string]>('SELECT channel_id FROM items WHERE id = ?').get('old')?.channel_id).toBe(GENERAL_CHANNEL);
    expect(db.query<{ item_id: string }, []>('SELECT item_id FROM fts_items').all()).toEqual([{ item_id: 'old' }]);
    // Running it again is a no-op, not an error (every boot calls it).
    expect(() => applySchema(db)).not.toThrow();
  });

  test('indexes messages by text and cards by title and body', () => {
    const db = fresh();
    put(db, 'm1', { text: 'Rent is due on Friday' });
    insert(db, {
      id: 'c1',
      kind: 'card',
      created_at: 2,
      updated_at: 2,
      channel_id: GENERAL_CHANNEL,
      card: { type: 'note', title: 'Lease renewal', status: 'info', body: 'The landlord raised the deposit' },
    });
    const hits = (q: string) => db.query<{ item_id: string }, [string]>('SELECT item_id FROM fts_items WHERE fts_items MATCH ?').all(q).map((r) => r.item_id);
    expect(hits('"rent"')).toEqual(['m1']);
    expect(hits('"deposit"')).toEqual(['c1']);
    expect(hits('"lease"')).toEqual(['c1']);
    expect(hits('"nonsense"')).toEqual([]);
  });

  test('an upserted item is reindexed, not duplicated', () => {
    const db = fresh();
    const save = (item: Item) => {
      db.query(
        `INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, json = excluded.json`,
      ).run(item.id, item.kind, item.created_at, item.updated_at, item.channel_id ?? GENERAL_CHANNEL, JSON.stringify(item));
      indexItem(db, item, item.channel_id ?? GENERAL_CHANNEL);
    };
    save({ id: 'i1', kind: 'user', created_at: 1, updated_at: 1, channel_id: GENERAL_CHANNEL, text: 'tomorrow: dentist' });
    save({ id: 'i1', kind: 'user', created_at: 1, updated_at: 2, channel_id: GENERAL_CHANNEL, text: 'dentist was fine' });
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM fts_items').get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM fts_items WHERE fts_items MATCH '"dentist"'`).get()?.n).toBe(1);
    // Porter stems "tomorrow" to itself, so its absence is a real check that the old text is gone.
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM fts_items WHERE fts_items MATCH '"tomorrow"'`).get()?.n).toBe(0);
  });

  test('deleting an item removes it from the index', () => {
    const db = fresh();
    put(db, 'i1', { text: 'temporary note' });
    db.query('DELETE FROM items WHERE id = ?').run('i1');
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM fts_items WHERE fts_items MATCH '"temporary"'`).get()?.n).toBe(0);
  });

  test('backfill indexes rows that predate the index, once', () => {
    const db = fresh();
    db.exec("INSERT INTO fts_items(item_id, channel_id, kind, text) VALUES ('keep', 'chan-general', 'user', 'already indexed')");
    put(db, 'late', { text: 'written before the triggers' });
    // Simulate a row that was written while the index did not exist.
    db.exec('DELETE FROM fts_items WHERE item_id = \'late\'');
    backfillItems(db);
    const ids = db.query<{ item_id: string }, []>('SELECT item_id FROM fts_items ORDER BY item_id').all().map((r) => r.item_id);
    expect(ids).toEqual(['keep', 'late']);
    backfillItems(db);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM fts_items').get()?.n).toBe(2);
  });

  test('items in a channel are indexed with that channel', () => {
    const db = fresh();
    put(db, 'i1', { text: 'tax paperwork' }, 'chan-taxes');
    expect(db.query<{ channel_id: string }, []>('SELECT channel_id FROM fts_items').get()?.channel_id).toBe('chan-taxes');
  });

  test('applySchema sets SCHEMA_VERSION = 4 and backfills tasks, pages, and latest file versions once', () => {
    const db = fresh();
    expect(SCHEMA_VERSION).toBe(4);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(4);

    db.query('INSERT INTO tasks(id, status, session_id, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)').run(
      't-bf',
      'done',
      's1',
      10,
      10,
      JSON.stringify({ id: 't-bf', title: 'Audit steps', status: 'done', steps: [{ text: 'Inspect meter reading' }], changed: 'Threshold lowered', created_at: 10, updated_at: 10, background: true }),
    );
    db.query('INSERT INTO tasks(id, status, session_id, created_at, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)').run(
      't-corrupt',
      'done',
      's1',
      11,
      11,
      '{not-json',
    );
    db.query('INSERT INTO files(id, path, created_at, json) VALUES (?, ?, ?, ?)').run(
      'f-old',
      '/tmp/f-old.md',
      20,
      JSON.stringify({ id: 'f-old', title: 'Checklist', name: 'checklist.md', mime: 'text/markdown', size: 10, created_at: 20 }),
    );
    db.query('INSERT INTO files(id, path, created_at, json) VALUES (?, ?, ?, ?)').run(
      'f-new',
      '/tmp/f-new.md',
      21,
      JSON.stringify({ id: 'f-new', title: 'Checklist', name: 'checklist.md', mime: 'text/markdown', size: 12, version_of: 'f-old', created_at: 21 }),
    );
    db.query('INSERT INTO files(id, path, created_at, json) VALUES (?, ?, ?, ?)').run(
      'f-corrupt',
      '/tmp/bad.md',
      22,
      '{bad-json',
    );
    db.query('INSERT INTO pages(id, created_at, json) VALUES (?, ?, ?)').run(
      'p-bf',
      30,
      JSON.stringify({ id: 'p-bf', title: 'Morning Standup', instructions: 'Compare blockers daily', file_id: 'f-new', created_at: 30, updated_at: 30 }),
    );
    db.query('INSERT INTO pages(id, created_at, json) VALUES (?, ?, ?)').run('p-corrupt', 31, '{bad');

    expect(() => backfillAssets(db)).not.toThrow();
    const refs = db.query<{ ref_id: string; kind: string }, []>('SELECT ref_id, kind FROM fts_assets ORDER BY ref_id').all();
    expect(refs).toEqual([
      { ref_id: 'f-new', kind: 'file' },
      { ref_id: 'p-bf', kind: 'page' },
      { ref_id: 't-bf', kind: 'task' },
    ]);
    // Running backfillAssets a second time is a no-op (no duplicate rows).
    backfillAssets(db);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM fts_assets').get()?.n).toBe(3);
  });

  test('upgrading from v3 refreshes fts_items and fts_assets to schema v4', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, run_id TEXT, task_id TEXT, channel_id TEXT DEFAULT 'chan-general', json TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE pages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE VIRTUAL TABLE fts_items USING fts5(item_id UNINDEXED, channel_id UNINDEXED, kind UNINDEXED, text, tokenize = 'porter unicode61');
      CREATE VIRTUAL TABLE fts_assets USING fts5(ref_id UNINDEXED, kind UNINDEXED, title, body, tokenize = 'porter unicode61');
      PRAGMA user_version = 3;
    `);
    db.query('INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)').run(
      'i-up',
      'user',
      1,
      1,
      GENERAL_CHANNEL,
      JSON.stringify({ id: 'i-up', kind: 'user', created_at: 1, updated_at: 1, attachments: [{ id: 'a1', name: 'upward-manifest.csv', mime: 'text/csv', size: 5, kind: 'file', created_at: 1 }] }),
    );
    db.query('INSERT INTO fts_items(item_id, channel_id, kind, text) VALUES (?, ?, ?, ?)').run('i-up', GENERAL_CHANNEL, 'user', 'stale');

    applySchema(db);
    expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(4);
    expect(db.query<{ item_id: string }, []>(`SELECT item_id FROM fts_items WHERE fts_items MATCH '"manifest"'`).all()).toEqual([{ item_id: 'i-up' }]);
  });
});
