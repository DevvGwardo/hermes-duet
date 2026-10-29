// Full-text search over the thread and the things the agent produced. The SQL lives here and takes a Database, so a
// test can drive it against an in-memory copy of the schema without touching the real install.
import type { Database } from 'bun:sqlite';
import type { SearchHit } from '../shared/types';

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
       0 AS created_at
FROM fts_assets
WHERE fts_assets MATCH ?
ORDER BY bm25(fts_assets)
LIMIT ?`;

/**
 * Ranked hits across the thread (messages and cards) and the agent's tasks, files and standing pages, newest first
 * among equally relevant matches. `limit` counts each source, and the merge keeps the best of both.
 */
export function search(database: Database, raw: string, limit = 20): SearchHit[] {
  const q = ftsQuery(raw);
  if (!q) return [];
  const n = Math.max(1, Math.min(50, limit));
  const itemRows = database.query<Row, [string, number]>(ITEM_SQL).all(q.match, n);
  const assetRows = database.query<Row, [string, number]>(ASSET_SQL).all(q.match, n);
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
