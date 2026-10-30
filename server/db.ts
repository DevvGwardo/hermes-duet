import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type Attachment, type Channel, type FileEntry, type Item, type Page, type Settings, type Task, attachmentKind } from '../shared/types';
import { type ChannelInput, slugFor } from './channels';
import { config } from './config';
import { lockDownDataDir } from './permissions';
import { GENERAL_CHANNEL, SCHEMA_VERSION, applySchema } from './schema';

mkdirSync(config.dataDir, { recursive: true });
lockDownDataDir(config.dataDir);
export const db = new Database(join(config.dataDir, 'duet.db'), { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_size_limit = 16777216;');
lockDownDataDir(config.dataDir);

/**
 * The database the last version left behind, copied before any ALTER runs. A bad migration is then recoverable by
 * hand instead of being a boot loop with no path back.
 */
function backupBeforeMigration(from: number) {
  const src = join(config.dataDir, 'duet.db');
  if (!existsSync(src)) return;
  // A brand-new checkout has an empty file and nothing to lose; only an install with real tables is worth copying.
  const tables = db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'items'`).get()?.n ?? 0;
  if (!tables) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const dir = join(config.dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, join(dir, `duet-v${from}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    // Keep the three most recent; older copies are the ones nobody would reach for.
    const stale = readdirSync(dir)
      .filter((f) => f.startsWith('duet-v') && f.endsWith('.db'))
      .sort()
      .slice(0, -3);
    for (const f of stale) rmSync(join(dir, f), { force: true });
  } catch (e: any) {
    console.error('[db] could not back up before migrating', e?.message ?? e);
  }
}

{
  const from = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  if (from < SCHEMA_VERSION) backupBeforeMigration(from);
}

applySchema(db);

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

/**
 * Run a unit of work as one transaction. Multi-statement writes (a task and its search row, a device and its
 * subscriptions) are otherwise only atomic per statement: a kill between them leaves a row nothing points at.
 * Bun nests these with savepoints, so a helper may call another safely.
 */
export const tx = <T>(fn: () => T): T => db.transaction(fn)();

// ---------- kv ----------
const kvGet = db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?');
const kvSet = db.query('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
export const kv = {
  get<T>(key: string, fallback: T): T {
    const row = kvGet.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      // settings.get and mainSessionId both read through here, so one corrupt value must not take the server down.
      console.error('[db] corrupt kv value for', key);
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    kvSet.run(key, JSON.stringify(value));
  },
};

// ---------- channels ----------
export interface ChannelRow extends Channel {
  seen_at?: number;
  archived_at?: number | null;
}

/** The Hermes session behind the general channel: the long-lived thread the app opens first. */
function createMainSession(): string {
  const id = `duet-main-${newId()}`;
  kv.set('main_session', id);
  return id;
}

const channelGet = db.query<ChannelRow, [string]>(
  'SELECT id, name, slug, topic, session_id, seen_at, archived_at, created_at, updated_at FROM channels WHERE id = ?',
);
const channelAll = db.query<ChannelRow, [string]>(
  `SELECT c.id, c.name, c.slug, c.topic, c.session_id, c.seen_at, c.archived_at, c.created_at, c.updated_at,
          (SELECT MAX(i.created_at) FROM items i WHERE i.channel_id = c.id) AS last_at
   FROM channels c WHERE c.archived_at IS NULL
   ORDER BY CASE WHEN c.id = ? THEN 0 ELSE 1 END, coalesce(last_at, c.created_at) DESC`,
);
const channelBySlug = db.query<ChannelRow, [string]>('SELECT * FROM channels WHERE slug = ?');
const channelInsert = db.query(
  'INSERT INTO channels(id, name, slug, topic, session_id, seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const channelTouch = db.query('UPDATE channels SET name = ?, topic = ?, archived_at = NULL, updated_at = ? WHERE id = ?');
const channelArchive = db.query('UPDATE channels SET archived_at = ?, updated_at = ? WHERE id = ?');
const channelSeen = db.query('UPDATE channels SET seen_at = ? WHERE id = ?');

export const channels = {
  /**
   * The general channel, created on first use. Its Hermes session is the install's main session, so an existing
   * checkout keeps its history after the channels migration instead of starting a new thread.
   */
  general(): ChannelRow {
    const row = channelGet.get(GENERAL_CHANNEL);
    if (row) return row;
    const session = kv.get<string>('main_session', '') || createMainSession();
    const now = Date.now();
    channelInsert.run(GENERAL_CHANNEL, 'general', 'general', 'Everything that is not a project of its own', session, null, now, now);
    return channelGet.get(GENERAL_CHANNEL)!;
  },
  all(): ChannelRow[] {
    channels.general();
    return channelAll.all(GENERAL_CHANNEL);
  },
  get(id: string): ChannelRow | null {
    return channelGet.get(id) ?? null;
  },
  bySlug(slug: string): ChannelRow | null {
    return channelBySlug.get(slug) ?? null;
  },
  /**
   * Create a channel, or bring back one that was archived under the same slug: the old session still has the
   * history, so un-archiving is what the user means by reusing a name.
   */
  create(input: ChannelInput): ChannelRow {
    const now = Date.now();
    const slug = slugFor(input.name);
    const reuse = () => {
      const existing = channels.bySlug(slug);
      if (!existing) return null;
      channelTouch.run(input.name, input.topic ?? null, now, existing.id);
      return channelGet.get(existing.id)!;
    };
    const found = reuse();
    if (found) return found;
    const id = `chan-${slug}-${newId().slice(-4)}`;
    try {
      tx(() => channelInsert.run(id, input.name, slug, input.topic ?? null, `duet-channel-${slug}`, null, now, now));
    } catch (e: any) {
      // Another create won the slug between the read and the insert: that is the same "already archived" answer.
      const again = reuse();
      if (again) return again;
      throw e;
    }
    return channelGet.get(id)!;
  },
  archive(id: string): boolean {
    if (id === GENERAL_CHANNEL) throw new Error('the general channel cannot be archived');
    if (!channelGet.get(id)) return false;
    channelArchive.run(Date.now(), Date.now(), id);
    return true;
  },
  /** Mark a channel read up to now; called when the app opens it. */
  seen(id: string) {
    channelSeen.run(Date.now(), id);
  },
  /**
   * Which channel an agent session belongs to. Background task sessions are not channels, so they fall back to
   * general: their result and handover card belong in the thread the user talks in.
   */
  bySession(sessionId: string): ChannelRow | null {
    return db.query<ChannelRow, [string]>('SELECT * FROM channels WHERE session_id = ?').get(sessionId) ?? null;
  },
  /** The channel a task's cards and handover belong to (tasks inherit the channel they were started from). */
  forTask(task: Task | null | undefined): string {
    return task?.channel_id && channels.get(task.channel_id) ? task.channel_id : GENERAL_CHANNEL;
  },
};

// ---------- full-text index for tasks, files and pages ----------
const ftsAssetDelete = db.query('DELETE FROM fts_assets WHERE ref_id = ?');
const ftsAssetInsert = db.query('INSERT INTO fts_assets(ref_id, kind, title, body) VALUES (?, ?, ?, ?)');
export const searchIndex = {
  put(refId: string, kind: 'task' | 'file' | 'page', title: string, body: string) {
    ftsAssetDelete.run(refId);
    ftsAssetInsert.run(refId, kind, title, body);
  },
  remove(refId: string) {
    ftsAssetDelete.run(refId);
  },
};

// ---------- items ----------
// `channel_id` is a real column so a channel's page is one index scan; the full item stays in `json`.
const itemUpsert = db.query(
  `INSERT INTO items(id, kind, created_at, updated_at, run_id, task_id, channel_id, json)
   VALUES ($id, $kind, $created_at, $updated_at, $run_id, $task_id, $channel_id, $json)
   ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, run_id = excluded.run_id, task_id = excluded.task_id,
     channel_id = excluded.channel_id, json = excluded.json`,
);
const itemGet = db.query<{ json: string }, [string]>('SELECT json FROM items WHERE id = ?');
const itemsLatest = db.query<{ json: string }, [number]>('SELECT json FROM items ORDER BY created_at DESC, id DESC LIMIT ?');
const itemsLatestIn = db.query<{ json: string }, [string, number]>(
  'SELECT json FROM items WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
);
const itemsBefore = db.query<{ json: string }, [number, number, string, number]>(
  'SELECT json FROM items WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?',
);
const itemsBeforeIn = db.query<{ json: string }, [string, number, number, string, number]>(
  'SELECT json FROM items WHERE channel_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?',
);
const itemsPending = db.query<{ json: string }, []>(
  `SELECT json FROM items WHERE kind = 'card' AND json_extract(json, '$.card.status') = 'pending' ORDER BY created_at`,
);
const itemsPendingIn = db.query<{ json: string }, [string]>(
  `SELECT json FROM items WHERE kind = 'card' AND channel_id = ? AND json_extract(json, '$.card.status') = 'pending' ORDER BY created_at`,
);
const itemsBriefsSince = db.query<{ json: string }, [number]>(
  `SELECT json FROM items WHERE kind = 'card' AND json_extract(json, '$.card.type') = 'brief' AND created_at >= ? ORDER BY created_at`,
);
const itemsChannel = db.query('UPDATE items SET channel_id = ? WHERE id = ?');

export const items = {
  save(item: Item) {
    itemUpsert.run({
      $id: item.id,
      $kind: item.kind,
      $created_at: item.created_at,
      $updated_at: item.updated_at,
      $run_id: item.run_id ?? null,
      $task_id: item.task_id ?? null,
      $channel_id: item.channel_id ?? GENERAL_CHANNEL,
      $json: JSON.stringify(item),
    });
    return item;
  },
  /** Move an existing item into a channel (a task's cards follow it when it hands over). */
  setChannel(id: string, channelId: string) {
    const item = items.get(id);
    if (!item || item.channel_id === channelId) return item;
    item.channel_id = channelId;
    items.save(item);
    return item;
  },
  get(id: string): Item | null {
    const row = itemGet.get(id);
    return row ? (JSON.parse(row.json) as Item) : null;
  },
  /** Newest page of the thread, whole install when `channelId` is omitted. */
  latest(limit: number, channelId?: string): { items: Item[]; has_more: boolean } {
    const rows = (channelId ? itemsLatestIn.all(channelId, limit + 1) : itemsLatest.all(limit + 1)).map((r) => JSON.parse(r.json) as Item);
    return { items: rows.slice(0, limit).reverse(), has_more: rows.length > limit };
  },
  before(id: string, limit: number, channelId?: string): { items: Item[]; has_more: boolean } {
    const ref = items.get(id);
    if (!ref) return { items: [], has_more: false };
    const rows = (
      channelId
        ? itemsBeforeIn.all(channelId, ref.created_at, ref.created_at, ref.id, limit + 1)
        : itemsBefore.all(ref.created_at, ref.created_at, ref.id, limit + 1)
    ).map((r) => JSON.parse(r.json) as Item);
    return { items: rows.slice(0, limit).reverse(), has_more: rows.length > limit };
  },
  pendingCards(channelId?: string): Item[] {
    return (channelId ? itemsPendingIn.all(channelId) : itemsPending.all()).map((r) => JSON.parse(r.json) as Item);
  },
  /** Brief cards (morning and check-in) posted at or after `since`, oldest first. */
  briefsSince(since: number): Item[] {
    return itemsBriefsSince.all(since).map((r) => JSON.parse(r.json) as Item);
  },
  channelOf(id: string): string {
    return items.get(id)?.channel_id ?? GENERAL_CHANNEL;
  },
};

// ---------- attachments ----------
const attachmentInsert = db.query(
  'INSERT INTO attachments(id, item_id, filename, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const attachmentGet = db.query<AttachmentRow, [string]>(
  'SELECT id, item_id, filename, mime, size, path, created_at FROM attachments WHERE id = ?',
);
const attachmentLink = db.query('UPDATE attachments SET item_id = ? WHERE id = ?');
export interface AttachmentRow {
  id: string;
  filename: string;
  mime: string;
  size: number;
  path: string;
  item_id: string | null;
  created_at: number;
}
export const attachments = {
  add(row: { id: string; filename: string; mime: string; size: number; path: string }): AttachmentRow {
    const created_at = Date.now();
    attachmentInsert.run(row.id, null, row.filename, row.mime, row.size, row.path, created_at);
    return { ...row, item_id: null, created_at };
  },
  get(id: string): AttachmentRow | null {
    return attachmentGet.get(id) ?? null;
  },
  /** Record which message carried each upload, so it can be listed and cleaned up with the thread. */
  link(ids: string[], itemId: string) {
    for (const id of ids) attachmentLink.run(itemId, id);
  },
};

export const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  name: r.filename,
  mime: r.mime,
  size: r.size,
  kind: attachmentKind(r.mime),
  created_at: r.created_at,
});

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
    tx(() => {
      taskUpsert.run({
        $id: task.id,
        $status: task.status,
        $session_id: sessionId ?? existing?.session_id ?? null,
        $created_at: task.created_at,
        $updated_at: task.updated_at,
        $json: JSON.stringify(task),
      });
      searchIndex.put(task.id, 'task', task.title, [task.result, task.progress, task.instructions].filter(Boolean).join('\n'));
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
const fileUpdate = db.query('UPDATE files SET json = ? WHERE id = ?');
export const files = {
  add(entry: FileEntry, path: string) {
    fileInsert.run(entry.id, path, entry.created_at, JSON.stringify(entry));
    searchIndex.put(entry.id, 'file', entry.title, entry.name);
    return entry;
  },
  update(entry: FileEntry) {
    fileUpdate.run(JSON.stringify(entry), entry.id);
    // Titles are searchable: a rename that didn't reach the index would keep the old title findable forever.
    searchIndex.put(entry.id, 'file', entry.title, entry.name);
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

// ---------- pages ----------
const pageUpsert = db.query('INSERT INTO pages(id, created_at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json');
const pageGet = db.query<{ json: string }, [string]>('SELECT json FROM pages WHERE id = ?');
const pagesAll = db.query<{ json: string }, []>('SELECT json FROM pages ORDER BY created_at');
export const pages = {
  save(page: Page) {
    page.updated_at = Date.now();
    pageUpsert.run(page.id, page.created_at, JSON.stringify(page));
    searchIndex.put(page.id, 'page', page.title, page.instructions);
    return page;
  },
  get(id: string): Page | null {
    const row = pageGet.get(id);
    return row ? (JSON.parse(row.json) as Page) : null;
  },
  all(): Page[] {
    return pagesAll.all().map((r) => JSON.parse(r.json) as Page);
  },
  remove(id: string) {
    db.query('DELETE FROM pages WHERE id = ?').run(id);
    searchIndex.remove(id);
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
  /** Close a run that is still marked running, leaving one that already ended with its real outcome. */
  abandon(id: string, error: string) {
    db.query(`UPDATE runs SET status = 'error', ended_at = ?, error = ? WHERE id = ? AND status = 'running'`).run(Date.now(), error, id);
  },
  recentFor(sessionId: string, limit: number): { id: string }[] {
    return db.query<{ id: string }, [string, number]>('SELECT id FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?').all(sessionId, limit);
  },
  /** Runs left 'running' by a crash or restart. */
  orphaned(): RunRow[] {
    return db.query<RunRow, []>(`SELECT id, kind, session_id, task_id, status, started_at, meta FROM runs WHERE status = 'running'`).all();
  },
};

/**
 * Unattended housekeeping. Run rows are bookkeeping (`running` is recovery's and is never touched) and expired pair
 * codes are dead weight. Thread items, files, attachments and TTS clips are kept: the history is the product, so
 * reclaiming bytes by deleting a user's conversation is not a trade this app makes behind their back.
 */
export function prune(now = Date.now()): { runs: number; codes: number } {
  const cut = now - 30 * 86400_000;
  const runs = db.query('DELETE FROM runs WHERE status != ? AND coalesce(ended_at, started_at) < ?').run('running', cut).changes;
  const codes = db.query('DELETE FROM pair_codes WHERE expires_at < ?').run(now).changes;
  // Cheaper than VACUUM and safe while the app is live: lets SQLite refresh its own statistics and query plans.
  try {
    db.exec('PRAGMA optimize');
  } catch {}
  return { runs, codes };
}

// ---------- devices ----------
export interface DeviceRow {
  id: string;
  name: string | null;
  created_at: number;
  last_seen: number;
}
const devicesAll = db.query<DeviceRow, []>('SELECT id, name, created_at, last_seen FROM devices ORDER BY created_at');
const deviceGet = db.query<{ id: string }, [string]>('SELECT id FROM devices WHERE id = ?');
const deviceDelete = db.query('DELETE FROM devices WHERE id = ?');
const subsDeleteForDevice = db.query('DELETE FROM push_subs WHERE device_id = ?');
export const devices = {
  all(): DeviceRow[] {
    return devicesAll.all();
  },
  /** Forget a paired device: its cookie stops working and its pushes stop being sent. */
  revoke(id: string): boolean {
    if (!deviceGet.get(id)) return false;
    tx(() => {
      subsDeleteForDevice.run(id);
      deviceDelete.run(id);
    });
    return true;
  },
};

// ---------- triggers ----------
export interface TriggerRow {
  id: string;
  kind: string;
  config_json: string;
  enabled: number;
  last_triggered_at: number | null;
  created_at: number;
}
const triggerAll = db.query<TriggerRow, []>('SELECT id, kind, config_json, enabled, last_triggered_at, created_at FROM triggers ORDER BY created_at');
const triggerUpsert = db.query(
  `INSERT INTO triggers(id, kind, config_json, enabled, last_triggered_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, enabled = excluded.enabled, last_triggered_at = excluded.last_triggered_at`,
);
const triggerTouch = db.query('UPDATE triggers SET last_triggered_at = ? WHERE id = ?');
export const triggers = {
  all(): TriggerRow[] {
    return triggerAll.all();
  },
  /** Record a trigger's state (a webhook's name, a watched folder) so it survives restarts. */
  save(row: { id: string; kind: string; config: unknown; enabled?: boolean; last_triggered_at?: number | null; created_at?: number }) {
    triggerUpsert.run(row.id, row.kind, JSON.stringify(row.config), row.enabled === false ? 0 : 1, row.last_triggered_at ?? null, row.created_at ?? Date.now());
    return row;
  },
  touch(id: string, at = Date.now()) {
    triggerTouch.run(at, id);
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

// Create the general channel at boot so the app, the CLI and the webhooks all have somewhere to put things.
channels.general();
