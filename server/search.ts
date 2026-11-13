// Full-text search over the thread and the things the agent produced. The SQL lives here and takes a Database, so a
// test can drive it against an in-memory copy of the schema without touching the real install.
import type { Database } from './sqlite';
import type { CardData, Item, SearchHit, Source, Task } from '../shared/types';

const MAX_TERMS = 8;
const MAX_QUERY = 200;
const MAX_SNIPPET = 220;

/**
 * What the user typed, as an FTS5 MATCH expression, and the words to highlight. Every word becomes a quoted prefix
 * term, which does two things: what they type mid-word still finds the message, and FTS5 syntax they happen to type
 * (`AND`, `NEAR`, `"`, `*`, `-`, `:`) is just a word rather than a broken query or an operator that changes meaning.
 * Returns null when there is nothing searchable in it.
 */
export function ftsQuery(raw: string): { match: string; terms: string[] } | null {
  const words = String(raw ?? '')
    .slice(0, MAX_QUERY)
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const terms = [...new Set(words)].slice(0, MAX_TERMS);
  return { match: terms.map((t) => `"${t}"*`).join(' AND '), terms };
}

/** FTS5 snippet output is already plain text; this keeps a hit from carrying a whole message into the list. */
function trimSnippet(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_SNIPPET ? `${t.slice(0, MAX_SNIPPET - 1)}…` : t;
}

/** A source's searchable text: the chip label and the verbatim quote backing it. */
function sourceText(sources: Source[] | undefined): string[] {
  const out: string[] = [];
  for (const s of sources ?? []) {
    if (s.label) out.push(s.label);
    if (s.quote) out.push(s.quote);
  }
  return out;
}

/**
 * Everything searchable on one item, flattened to plain text. This is the single place that knows which card
 * subfields matter, so a decision, a draft, a follow-up or a line item is findable like a message. Pure on purpose:
 * the trigger-free index writer, the boot reindex and the tests all call this one function.
 */
export function searchText(item: Item): string {
  const parts: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  };
  add(item.text);
  for (const a of item.attachments ?? []) add(a.name);
  const card: CardData | undefined = item.card;
  if (card) {
    add(card.title);
    add(card.body);
    add(card.draft);
    add(card.content);
    add(card.destination);
    add(card.url);
    add(card.action_label);
    add(card.scan_warning);
    add(card.merchant);
    add(card.merchant_host);
    add(card.card_summary);
    for (const r of card.recipients ?? []) add(r);
    for (const o of card.options ?? []) add(o);
    for (const e of card.entries ?? []) {
      add(e.title);
      add(e.detail);
      add(e.draft);
      add(e.action_message);
      add(e.action_label);
      parts.push(...sourceText(e.sources));
    }
    for (const w of card.watching ?? []) {
      add(w.title);
      add(w.detail);
      parts.push(...sourceText(w.sources));
    }
    for (const f of card.follow_ups ?? []) {
      add(f.label);
      add(f.message);
    }
    for (const c of card.checklist ?? []) add(c.text);
    for (const m of card.metrics ?? []) {
      add(m.label);
      add(m.value);
      add(m.delta);
    }
    for (const p of card.line_items ?? []) add(p.title);
    parts.push(...sourceText(card.sources));
  }
  return parts.join('\n');
}

/** The searchable body of a task: its result, progress, instructions, steps, change note, suggested follow-ups and sources. */
export function taskSearchText(task: Task): string {
  const parts = [task.result, task.progress, task.instructions, task.changed, ...sourceText(task.sources)];
  for (const s of task.steps ?? []) parts.push(s.text);
  for (const f of task.follow_ups ?? []) parts.push(f.label, f.message);
  return parts.filter(Boolean).join('\n');
}

/**
 * Replace one item's search row. The whole row is rewritten, so an edit never leaves the old text findable, and an
 * item with nothing searchable leaves no row at all. `channelId` is passed in because the caller already knows it.
 */
export function indexItem(database: Database, item: Item, channelId: string) {
  database.query('DELETE FROM fts_items WHERE item_id = ?').run(item.id);
  const text = searchText(item);
  if (!text.trim()) return;
  database.query('INSERT INTO fts_items(item_id, channel_id, kind, text) VALUES (?, ?, ?, ?)').run(item.id, channelId, item.kind, text);
}

interface Row {
  id: string;
  kind: string;
  title: string;
  snip: string;
  created_at: number;
  channel_id?: string;
}

// FTS5's auxiliary functions (snippet, bm25) need the table's own name, so the FTS table is not aliased here.
const ITEM_SQL = `
SELECT fts_items.item_id AS id, fts_items.kind AS kind,
       coalesce(nullif(json_extract(i.json, '$.card.title'), ''), json_extract(i.json, '$.text'), '') AS title,
       coalesce(snippet(fts_items, -1, '', '', ' … ', 14), '') AS snip,
       i.created_at AS created_at, fts_items.channel_id AS channel_id
FROM fts_items JOIN items i ON i.id = fts_items.item_id
WHERE fts_items MATCH ?
ORDER BY bm25(fts_items)
LIMIT ?`;

const ASSET_SQL = `
SELECT fts_assets.ref_id AS id, fts_assets.kind AS kind, fts_assets.title AS title,
       coalesce(snippet(fts_assets, -1, '', '', ' … ', 14), '') AS snip,
       coalesce(t.created_at, f.created_at, p.created_at, 0) AS created_at
FROM fts_assets
LEFT JOIN tasks t ON fts_assets.kind = 'task' AND t.id = fts_assets.ref_id
LEFT JOIN files f ON fts_assets.kind = 'file' AND f.id = fts_assets.ref_id
LEFT JOIN pages p ON fts_assets.kind = 'page' AND p.id = fts_assets.ref_id
WHERE fts_assets MATCH ?
ORDER BY bm25(fts_assets)
LIMIT ?`;

function assetRowsFor(database: Database, match: string, limit: number): Row[] {
  // Partial/pre-migration test DBs may have `fts_assets` without all three asset tables yet; join only what exists.
  const tables = new Set(
    database
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tasks', 'files', 'pages')`)
      .all()
      .map((r) => r.name),
  );
  if (tables.size === 3) return database.query<Row, [string, number]>(ASSET_SQL).all(match, limit);
  const cols: string[] = [];
  const joins: string[] = [];
  if (tables.has('tasks')) {
    cols.push('t.created_at');
    joins.push(`LEFT JOIN tasks t ON fts_assets.kind = 'task' AND t.id = fts_assets.ref_id`);
  }
  if (tables.has('files')) {
    cols.push('f.created_at');
    joins.push(`LEFT JOIN files f ON fts_assets.kind = 'file' AND f.id = fts_assets.ref_id`);
  }
  if (tables.has('pages')) {
    cols.push('p.created_at');
    joins.push(`LEFT JOIN pages p ON fts_assets.kind = 'page' AND p.id = fts_assets.ref_id`);
  }
  const createdExpr = cols.length ? `coalesce(${cols.join(', ')}, 0)` : '0';
  const sql = `
SELECT fts_assets.ref_id AS id, fts_assets.kind AS kind, fts_assets.title AS title,
       coalesce(snippet(fts_assets, -1, '', '', ' … ', 14), '') AS snip,
       ${createdExpr} AS created_at
FROM fts_assets
${joins.join('\n')}
WHERE fts_assets MATCH ?
ORDER BY bm25(fts_assets)
LIMIT ?`;
  return database.query<Row, [string, number]>(sql).all(match, limit);
}

/**
 * Ranked hits across the thread (messages and cards) and the agent's tasks, files and standing pages, newest first
 * among equally relevant matches. `limit` counts each source, and the merge keeps the best of both.
 */
export function search(database: Database, raw: string, limit = 20): SearchHit[] {
  const q = ftsQuery(raw);
  if (!q) return [];
  const n = Math.max(1, Math.min(50, limit));
  const itemRows = database.query<Row, [string, number]>(ITEM_SQL).all(q.match, n);
  const assetRows = assetRowsFor(database, q.match, n);
  // The two indexes score on different corpora, so their bm25 numbers are not comparable. Interleaving keeps both in
  // the running without pretending one outranks the other, and `limit` stays the number of hits returned.
  const rows: Row[] = [];
  for (let i = 0; i < Math.max(itemRows.length, assetRows.length) && rows.length < n; i++) {
    if (itemRows[i]) rows.push(itemRows[i]);
    if (assetRows[i] && rows.length < n) rows.push(assetRows[i]);
  }
  return rows.map((r): SearchHit => {
    const title = (r.title || '').replace(/\s+/g, ' ').trim().slice(0, 140) || 'Untitled';
    const snip = trimSnippet(r.snip || '');
    return {
      kind: (r.kind === 'task' || r.kind === 'file' || r.kind === 'page' ? r.kind : 'item') as SearchHit['kind'],
      id: r.id,
      title,
      // A title-only match (a card's heading) has no body context to quote; the title is the hit.
      snippet: snip || title,
      created_at: r.created_at,
      ...(r.channel_id ? { channel_id: r.channel_id } : {}),
    };
  });
}
