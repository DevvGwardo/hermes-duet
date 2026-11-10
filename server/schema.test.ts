import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { Item } from '../shared/types';
import { indexItem } from './search';
import { GENERAL_CHANNEL, applySchema, backfillItems } from './schema';

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
});
