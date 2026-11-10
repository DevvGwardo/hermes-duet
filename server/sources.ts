// Pure validation for the structured citations behind brief entries, cards and
// task results. Kept out of runner.ts so it can be tested without a database:
// the caller passes a `lookup` over its own collections, and an unknown local
// id fails the tool call instead of posting a citation that opens nothing.

import type { Source } from '../shared/types';

export const SOURCE_KINDS = ['item', 'task', 'file', 'page', 'url', 'connector', 'other'] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Whether a local id of this kind exists; the server wires this to its own collections. */
export type SourceLookup = (kind: SourceKind, id: string) => boolean;

/** At most this many citations ride on one entry, card or task result. */
export const MAX_SOURCES = 6;

/** What fits on a chip / in a short excerpt. */
export const MAX_LABEL = 120;
export const MAX_QUOTE = 300;

// Control characters never belong in a rendered chip. Labels stay single-line,
// so they allow none at all; quotes are verbatim excerpts, so tab and newline
// survive but nothing else from the C0 block (or DEL) does.
const LABEL_BAD = new RegExp('[\\x00-\\x1F\\x7F]');
const QUOTE_BAD = new RegExp('[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]');

/**
 * Validate and normalize a raw `sources` list from a tool call. Missing means
 * no citations; anything malformed throws naming the bad entry (`sources[2]`)
 * so the agent can fix that source instead of guessing.
 */
export function parseSources(raw: unknown, lookup: SourceLookup = () => true): Source[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('sources must be a list of at most 6 entries');
  if (!raw.length) return undefined;
  if (raw.length > MAX_SOURCES) throw new Error(`sources holds at most ${MAX_SOURCES} entries (got ${raw.length})`);
  return raw.map((entry, i) => parseSource(entry, i, lookup));
}

function parseSource(entry: unknown, i: number, lookup: SourceLookup): Source {
  const at = `sources[${i}]`;
  if (typeof entry !== 'object' || entry === null) throw new Error(`${at}: must be an object with kind and label`);
  const raw = entry as Record<string, unknown>;
  if (typeof raw.kind !== 'string' || !(SOURCE_KINDS as readonly string[]).includes(raw.kind)) {
    throw new Error(`${at}: unknown kind ${JSON.stringify(raw.kind) ?? 'missing'}, expected one of ${SOURCE_KINDS.join(', ')}`);
  }
  const kind = raw.kind as Source['kind'];
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) throw new Error(`${at}: label is required (what to show on the chip)`);
  if (label.length > MAX_LABEL) throw new Error(`${at}: label is too long (${label.length} chars, at most ${MAX_LABEL})`);
  if (LABEL_BAD.test(label)) throw new Error(`${at}: label must not contain control characters`);

  let quote: string | undefined;
  if (raw.quote !== undefined && raw.quote !== null) {
    if (typeof raw.quote !== 'string') throw new Error(`${at}: quote must be a string`);
    const q = raw.quote.trim();
    if (q) {
      if (q.length > MAX_QUOTE) throw new Error(`${at}: quote is too long (${q.length} chars, at most ${MAX_QUOTE})`);
      if (QUOTE_BAD.test(q)) throw new Error(`${at}: quote must not contain control characters`);
      quote = q;
    }
  }

  if (kind === 'url') {
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!url) throw new Error(`${at}: a url source needs an absolute http(s) URL`);
    if (!isHttpUrl(url)) throw new Error(`${at}: url must be an absolute http(s) URL (got ${JSON.stringify(url.slice(0, 80))})`);
    return quote ? { kind, url, label, quote } : { kind, url, label };
  }

  if (kind === 'item' || kind === 'task' || kind === 'file' || kind === 'page') {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) throw new Error(`${at}: an ${kind} source needs its ${kind} id (never invent one)`);
    if (!lookup(kind, id)) throw new Error(`${at}: no ${kind} with id ${JSON.stringify(id)}`);
    return quote ? { kind, id, label, quote } : { kind, id, label };
  }

  // connector / other: there is no registry to check, so the label is the citation.
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined;
  const base: Source = id ? { kind, id, label } : { kind, label };
  return quote ? { ...base, quote } : base;
}

/** Absolute http(s) URLs only: what a url chip may link to. */
export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One line per citation, for prompts and test assertions. Empty when there is
 * nothing to cite, so callers can skip the whole block.
 */
export function summarizeSources(sources: Source[] | undefined): string {
  if (!sources?.length) return '';
  return sources
    .map((s) => {
      const where = s.kind === 'url' ? (s.url ?? '') : s.id ? `${s.kind} ${s.id}` : s.kind;
      return `- [${s.kind}] ${s.label} (${where})${s.quote ? ` — "${s.quote}"` : ''}`;
    })
    .join('\n');
}
