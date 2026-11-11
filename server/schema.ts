// The database shape, kept out of db.ts so a test can build it in memory. Every statement is idempotent: a checkout
// that has been running for months gets the new columns and indexes on its next boot, and nothing is dropped.
import type { Database } from 'bun:sqlite';
import type { FileEntry, Item, Page, Task } from '../shared/types';
import { indexItem, taskSearchText } from './search';

/** The channel every existing row belongs to, and the one the brief, check-ins and tasks live in. */
export const GENERAL_CHANNEL = 'chan-general';

function columns(db: Database, table: string): Set<string> {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}

/**
 * Add a column to a table that predates it. SQLite has no `ADD COLUMN IF NOT EXISTS`, and re-running a plain ALTER
 * is an error, so the current shape is read first.
 */
function addColumn(db: Database, table: string, name: string, decl: string) {
  if (columns(db, table).has(name)) return;
  // The name is always quoted: `group` is a reserved word, and quoting a plain name like channel_id is harmless.
  db.exec(`ALTER TABLE ${table} ADD COLUMN "${name}" ${decl}`);
}

/**
 * Bumped whenever a shape change needs more than an idempotent CREATE. Kept in `PRAGMA user_version`, so a checkout
 * that has been running for months applies the step it is missing instead of guessing from the tables it can see.
 */
export const SCHEMA_VERSION = 4;

export function applySchema(db: Database) {
  const from = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  run_id TEXT, task_id TEXT, json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at, id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, session_id TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT, meta TEXT
);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS tasks_status_updated ON tasks(status, updated_at);
CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, device_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pair_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`);

  // Migration 002: topic channels. The default channel is created by db.ts, which knows the main Hermes session.
  db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  topic TEXT,
  session_id TEXT NOT NULL,
  seen_at INTEGER,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_session ON channels(session_id);
`);
  addColumn(db, 'items', 'channel_id', `TEXT DEFAULT '${GENERAL_CHANNEL}'`);
  db.exec(`CREATE INDEX IF NOT EXISTS items_channel ON items(channel_id, created_at)`);
  // Standing instructions and the strip group, added after seen_at the same way: old checkouts gain the columns
  // on boot, existing rows read back as NULL, and nothing stored is touched.
  addColumn(db, 'channels', 'instructions', 'TEXT');
  addColumn(db, 'channels', 'group', 'TEXT');
  // The GitHub repo a channel works in, normalized to an https://github.com/owner/name URL (see channels.ts).
  addColumn(db, 'channels', 'repo', 'TEXT');
  // Pending cards are read on every snapshot build, every badge count and every steer. An expression index on the
  // JSON path (partial to kind='card') turns that from a scan of the whole thread into a range read.
  db.exec(`CREATE INDEX IF NOT EXISTS items_card_status ON items(json_extract(json, '$.card.status'), created_at) WHERE kind = 'card'`);

  // Camera photos, voice memos and documents the user hands over from the composer.
  db.exec(`
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_item ON attachments(item_id);
`);

  // User-defined recurring routines. The columns the scheduler filters on (enabled, next_run) stay out of the JSON;
  // `json` carries the whole Routine, including the self-contained prompt.
  db.exec(`
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run INTEGER,
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS routines_next_run ON routines(next_run);
`);

  // Event-driven proactivity: webhooks, watched folders, calendar proximity.
  db.exec(`
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_triggered_at INTEGER,
  created_at INTEGER NOT NULL
);
`);

  // Full-text index over thread items. One row per item, written by db.items.save (and rebuilt here on upgrade)
  // from searchText(), so the card subfields are flattened in one place instead of a trigger's json_extract per field.
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
  item_id UNINDEXED,
  channel_id UNINDEXED,
  kind UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
`);
  // Tasks, delivered files and standing pages are searched alongside the thread; they are small and written from
  // code, so they get one index kept in step by db.ts rather than triggers on tables whose JSON shape varies.
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS fts_assets USING fts5(
  ref_id UNINDEXED,
  kind UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);
`);

  // Migration 003: card subfields. The old index knew only card.title and card.body, so a decision, a draft, a
  // follow-up or a line item was invisible. FTS5 tables cannot be altered, so the index is dropped and rebuilt
  // from the items themselves; the triggers that maintained it are gone (db.items.save owns the row now).
  if (from < 3) {
    db.exec('DROP TABLE IF EXISTS fts_items');
    db.exec(`
CREATE VIRTUAL TABLE fts_items USING fts5(
  item_id UNINDEXED,
  channel_id UNINDEXED,
  kind UNINDEXED,
  text,
  tokenize = 'porter unicode61'
);
`);
  }
  db.exec(`
DROP TRIGGER IF EXISTS items_fts_insert;
DROP TRIGGER IF EXISTS items_fts_update;
DROP TRIGGER IF EXISTS items_fts_delete;
CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
  DELETE FROM fts_items WHERE item_id = old.id;
END;
`);

  // One reconcile per schema version rather than an anti-join over the whole thread on every boot.
  // Migration 004: searchText/taskSearchText gained attachments, URLs/hosts, task steps/changed, and edited
  // file versions drop superseded rows from fts_assets.
  if (from < SCHEMA_VERSION) {
    if (from >= 3 && from < 4) db.exec('DELETE FROM fts_items');
    if (from < 4) db.exec('DELETE FROM fts_assets');
    backfillItems(db);
    backfillAssets(db);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Index rows written before the FTS table existed (or while it had the old shape). Cheap and idempotent: only
 * ids absent from the index are touched, so it costs one scan of the ids on a normal boot.
 */
export function backfillItems(db: Database) {
  const indexed = new Set(db.query<{ item_id: string }, []>('SELECT item_id FROM fts_items').all().map((r) => r.item_id));
  const rows = db.query<{ id: string; channel_id: string | null; json: string }, []>('SELECT id, channel_id, json FROM items').all();
  for (const r of rows) {
    if (indexed.has(r.id)) continue;
    let item: Item;
    try {
      item = JSON.parse(r.json) as Item;
    } catch {
      continue;
    }
    // The stored JSON is the full item in production, but a row written by an older version (or a test) may not
    // carry its own id; the column is the truth the index is keyed on.
    indexItem(db, { ...item, id: r.id }, r.channel_id ?? GENERAL_CHANNEL);
  }
}

/**
 * Rebuild missing asset search rows (tasks, current file versions, pages). Superseded files named by a newer
 * entry's `version_of` stay in `files` for Version Compare but stay out of Search so edits don't create duplicates.
 */
export function backfillAssets(db: Database) {
  const indexed = new Set(db.query<{ ref_id: string }, []>('SELECT ref_id FROM fts_assets').all().map((r) => r.ref_id));
  const put = db.query('INSERT INTO fts_assets(ref_id, kind, title, body) VALUES (?, ?, ?, ?)');
  for (const r of db.query<{ id: string; json: string }, []>('SELECT id, json FROM tasks').all()) {
    if (indexed.has(r.id)) continue;
    try {
      const task = JSON.parse(r.json) as Task;
      put.run(r.id, 'task', task.title, taskSearchText({ ...task, id: r.id }));
    } catch {}
  }
  const fileRows = db.query<{ id: string; json: string }, []>('SELECT id, json FROM files').all();
  const parsedFiles: { id: string; entry: FileEntry }[] = [];
  const superseded = new Set<string>();
  for (const r of fileRows) {
    try {
      const entry = JSON.parse(r.json) as FileEntry;
      parsedFiles.push({ id: r.id, entry });
      if (entry.version_of) superseded.add(entry.version_of);
    } catch {}
  }
  for (const { id, entry } of parsedFiles) {
    if (indexed.has(id) || superseded.has(id)) continue;
    put.run(id, 'file', entry.title, entry.name);
  }
  for (const r of db.query<{ id: string; json: string }, []>('SELECT id, json FROM pages').all()) {
    if (indexed.has(r.id)) continue;
    try {
      const page = JSON.parse(r.json) as Page;
      put.run(r.id, 'page', page.title, page.instructions);
    } catch {}
  }
}
