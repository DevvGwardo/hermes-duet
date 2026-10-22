import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FileEntry, Item, Settings, Task } from '../shared/types';
import { config } from './config';

mkdirSync(config.dataDir, { recursive: true });
export const db = new Database(join(config.dataDir, 'duet.db'), { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

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
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, name TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL, device_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pair_codes (code TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`);

let lastTs = 0;
let seq = 0;
/** Time-sortable id: 9 base36 chars of ms clock + 2 sequence chars + 4 random chars. */
export function newId(): string {
  const now = Date.now();
  if (now === lastTs) seq++;
  else {
    lastTs = now;
    seq = 0;
  }
  const rand = crypto.getRandomValues(new Uint8Array(3));
  const r = Array.from(rand, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 4);
  return now.toString(36).padStart(9, '0') + seq.toString(36).padStart(2, '0') + r;
}

// ---------- kv ----------
const kvGet = db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?');
const kvSet = db.query('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
export const kv = {
  get<T>(key: string, fallback: T): T {
    const row = kvGet.get(key);
    return row ? (JSON.parse(row.value) as T) : fallback;
  },
  set(key: string, value: unknown) {
    kvSet.run(key, JSON.stringify(value));
  },
};

// ---------- items ----------
const itemUpsert = db.query(
  `INSERT INTO items(id, kind, created_at, updated_at, run_id, task_id, json) VALUES ($id, $kind, $created_at, $updated_at, $run_id, $task_id, $json)
   ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, run_id = excluded.run_id, task_id = excluded.task_id, json = excluded.json`,
);
const itemGet = db.query<{ json: string }, [string]>('SELECT json FROM items WHERE id = ?');
const itemsLatest = db.query<{ json: string }, [number]>('SELECT json FROM items ORDER BY created_at DESC, id DESC LIMIT ?');
const itemsBefore = db.query<{ json: string }, [number, number, string, number]>(
  'SELECT json FROM items WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?',
);
const itemsPending = db.query<{ json: string }, []>(
  `SELECT json FROM items WHERE kind = 'card' AND json_extract(json, '$.card.status') = 'pending' ORDER BY created_at`,
);

export const items = {
  save(item: Item) {
    itemUpsert.run({
      $id: item.id,
      $kind: item.kind,
      $created_at: item.created_at,
      $updated_at: item.updated_at,
      $run_id: item.run_id ?? null,
      $task_id: item.task_id ?? null,
      $json: JSON.stringify(item),
    });
    return item;
  },
  get(id: string): Item | null {
    const row = itemGet.get(id);
    return row ? (JSON.parse(row.json) as Item) : null;
  },
  latest(limit: number): { items: Item[]; has_more: boolean } {
    const rows = itemsLatest.all(limit + 1).map((r) => JSON.parse(r.json) as Item);
    return { items: rows.slice(0, limit).reverse(), has_more: rows.length > limit };
  },
  before(id: string, limit: number): { items: Item[]; has_more: boolean } {
    const ref = items.get(id);
    if (!ref) return { items: [], has_more: false };
    const rows = itemsBefore.all(ref.created_at, ref.created_at, ref.id, limit + 1).map((r) => JSON.parse(r.json) as Item);
    return { items: rows.slice(0, limit).reverse(), has_more: rows.length > limit };
  },
  pendingCards(): Item[] {
    return itemsPending.all().map((r) => JSON.parse(r.json) as Item);
  },
};

// ---------- tasks ----------
const taskUpsert = db.query(
  `INSERT INTO tasks(id, status, session_id, created_at, updated_at, json) VALUES ($id, $status, $session_id, $created_at, $updated_at, $json)
   ON CONFLICT(id) DO UPDATE SET status = excluded.status, session_id = excluded.session_id, updated_at = excluded.updated_at, json = excluded.json`,
);
const taskGet = db.query<{ json: string; session_id: string | null }, [string]>('SELECT json, session_id FROM tasks WHERE id = ?');
const tasksRecent = db.query<{ json: string }, [number]>(
  `SELECT json FROM tasks WHERE status IN ('queued','running','waiting') OR updated_at > ? ORDER BY updated_at DESC LIMIT 60`,
);

export const tasks = {
  save(task: Task, sessionId?: string | null) {
    const existing = taskGet.get(task.id);
    taskUpsert.run({
      $id: task.id,
      $status: task.status,
      $session_id: sessionId ?? existing?.session_id ?? null,
      $created_at: task.created_at,
      $updated_at: task.updated_at,
      $json: JSON.stringify(task),
    });
    return task;
  },
  get(id: string): Task | null {
    const row = taskGet.get(id);
    return row ? (JSON.parse(row.json) as Task) : null;
  },
  sessionOf(id: string): string | null {
    return taskGet.get(id)?.session_id ?? null;
  },
  recent(): Task[] {
    return tasksRecent.all(Date.now() - 7 * 86400_000).map((r) => JSON.parse(r.json) as Task);
  },
};

// ---------- files ----------
const fileInsert = db.query('INSERT INTO files(id, path, created_at, json) VALUES (?, ?, ?, ?)');
const fileGet = db.query<{ json: string; path: string }, [string]>('SELECT json, path FROM files WHERE id = ?');
const filesAll = db.query<{ json: string }, []>('SELECT json FROM files ORDER BY created_at DESC LIMIT 200');
export const files = {
  add(entry: FileEntry, path: string) {
    fileInsert.run(entry.id, path, entry.created_at, JSON.stringify(entry));
    return entry;
  },
  get(id: string): { entry: FileEntry; path: string } | null {
    const row = fileGet.get(id);
    return row ? { entry: JSON.parse(row.json) as FileEntry, path: row.path } : null;
  },
  all(): FileEntry[] {
    return filesAll.all().map((r) => JSON.parse(r.json) as FileEntry);
  },
};

// ---------- runs ----------
export interface RunRow {
  id: string;
  kind: string;
  session_id: string;
  task_id: string | null;
  status: string;
  started_at: number;
  meta: string | null;
}
export const runs = {
  start(id: string, kind: string, sessionId: string, taskId: string | null, meta: unknown) {
    db.query('INSERT INTO runs(id, kind, session_id, task_id, status, started_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      kind,
      sessionId,
      taskId,
      'running',
      Date.now(),
      JSON.stringify(meta),
    );
  },
  meta(id: string, meta: unknown) {
    db.query('UPDATE runs SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  },
  end(id: string, status: string, error?: string) {
    db.query('UPDATE runs SET status = ?, ended_at = ?, error = ? WHERE id = ?').run(status, Date.now(), error ?? null, id);
  },
  recentFor(sessionId: string, limit: number): { id: string }[] {
    return db.query<{ id: string }, [string, number]>('SELECT id FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?').all(sessionId, limit);
  },
  /** Runs left 'running' by a crash or restart. */
  orphaned(): RunRow[] {
    return db.query<RunRow, []>(`SELECT id, kind, session_id, task_id, status, started_at, meta FROM runs WHERE status = 'running'`).all();
  },
};

// ---------- settings ----------
const DEFAULT_SETTINGS: Settings = {
  brief_enabled: true,
  brief_time: '07:30',
  checkins: 'off',
  quiet_start: '21:30',
  quiet_end: '07:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};
export const settings = {
  get(): Settings {
    return { ...DEFAULT_SETTINGS, ...kv.get<Partial<Settings>>('settings', {}) };
  },
  update(patch: Partial<Settings>): Settings {
    const clean: Partial<Settings> = {};
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof patch.brief_enabled === 'boolean') clean.brief_enabled = patch.brief_enabled;
    if (typeof patch.brief_time === 'string' && hhmm.test(patch.brief_time)) clean.brief_time = patch.brief_time;
    if (patch.checkins && ['off', '3x', 'hourly'].includes(patch.checkins)) clean.checkins = patch.checkins;
    if (typeof patch.quiet_start === 'string' && hhmm.test(patch.quiet_start)) clean.quiet_start = patch.quiet_start;
    if (typeof patch.quiet_end === 'string' && hhmm.test(patch.quiet_end)) clean.quiet_end = patch.quiet_end;
    if (typeof patch.timezone === 'string') {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone });
        clean.timezone = patch.timezone;
      } catch {}
    }
    const next = { ...settings.get(), ...clean };
    kv.set('settings', next);
    return next;
  },
};
