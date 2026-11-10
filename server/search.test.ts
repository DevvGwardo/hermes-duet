import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { Item } from '../shared/types';
import { GENERAL_CHANNEL, applySchema } from './schema';
import { ftsQuery, indexItem, search, searchText, taskSearchText } from './search';

/** Insert an item and index it, the way db.items.save does. */
function save(db: Database, item: Item) {
  db.query('INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)').run(
    item.id,
    item.kind,
    item.created_at,
    item.updated_at,
    item.channel_id ?? GENERAL_CHANNEL,
    JSON.stringify(item),
  );
  indexItem(db, item, item.channel_id ?? GENERAL_CHANNEL);
}

function seeded(): Database {
  const db = new Database(':memory:');
  applySchema(db);
  save(db, { id: 'a', kind: 'user', created_at: 1000, updated_at: 1000, channel_id: 'chan-general', text: 'Can you pay the rent before Friday?' });
  save(db, { id: 'b', kind: 'assistant', created_at: 2000, updated_at: 2000, channel_id: 'chan-general', text: 'The rent payment went out this morning.' });
  save(db, {
    id: 'c',
    kind: 'card',
    created_at: 3000,
    updated_at: 3000,
    channel_id: 'chan-finances',
    card: { type: 'note', title: 'Tax documents', status: 'info', body: 'The accountant needs the rent receipts.' },
  });
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

describe('searchText', () => {
  test('flattens every card subfield into one searchable text', () => {
    const text = searchText({
      id: 'x',
      kind: 'card',
      created_at: 1,
      updated_at: 1,
      card: {
        type: 'brief',
        title: 'Morning brief',
        status: 'info',
        body: 'A summary of the day',
        draft: 'A prepared reply about the roof deposit',
        entries: [{ title: 'Fix the garage door', detail: 'The spring snapped', action_message: 'Call the repairman' }],
        watching: [{ title: 'Permit status', detail: 'The city permit is pending' }],
        follow_ups: [{ label: 'Send the invoice', message: 'Email the contractor invoice' }],
        checklist: [{ text: 'Book the dentist' }],
        metrics: [{ label: 'Savings', value: '$4,200', delta: '+$120' }],
        sources: [{ kind: 'url', label: 'City permit office', quote: 'Permit #4471 was issued' }],
      },
    }).toLowerCase();
    for (const word of ['roof', 'deposit', 'garage', 'spring', 'repairman', 'permit', 'invoice', 'dentist', 'savings', '4471']) {
      expect(text).toContain(word);
    }
  });

  test('payment and approval fields are searchable too', () => {
    const text = searchText({
      id: 'y',
      kind: 'card',
      created_at: 1,
      updated_at: 1,
      card: {
        type: 'payment',
        title: 'Acme Hardware',
        status: 'pending',
        merchant: 'Acme Hardware',
        destination: 'checkout.acme.example',
        recipients: ['dana@example.com'],
        content: 'Pay the galvanized nails invoice',
        line_items: [{ title: 'Galvanized nails', price_cents: 1200 }],
      },
    }).toLowerCase();
    for (const word of ['acme', 'checkout', 'dana', 'galvanized', 'nails']) expect(text).toContain(word);
  });

  test('task text carries the result, follow-ups and source quotes', () => {
    const text = taskSearchText({
      id: 't1',
      title: 'Permit research',
      status: 'done',
      steps: [],
      created_at: 1,
      updated_at: 1,
      background: true,
      result: 'The city issued permit #4471.',
      follow_ups: [{ label: 'Email the permit', message: 'Send permit #4471 to Dana' }],
      sources: [{ kind: 'url', label: 'City permit office', quote: 'Permit #4471 was issued' }],
    }).toLowerCase();
    for (const word of ['4471', 'permit', 'dana', 'city permit office']) expect(text).toContain(word);
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

  test('a card draft is findable and the snippet shows it', () => {
    const db = seeded();
    save(db, {
      id: 'd1',
      kind: 'card',
      created_at: 4000,
      updated_at: 4000,
      channel_id: 'chan-general',
      card: { type: 'approval', title: 'Roof repair', status: 'pending', draft: 'Please pay the roof deposit from the household account.' },
    });
    const hits = search(db, 'deposit');
    expect(hits.map((h) => h.id)).toContain('d1');
    const hit = hits.find((h) => h.id === 'd1')!;
    expect(hit.snippet.toLowerCase()).toContain('deposit');
  });

  test('a brief entry detail is findable', () => {
    const db = seeded();
    save(db, {
      id: 'e1',
      kind: 'card',
      created_at: 4000,
      updated_at: 4000,
      channel_id: 'chan-general',
      card: {
        type: 'brief',
        title: 'Morning brief',
        status: 'info',
        entries: [{ title: 'Fix the garage door', detail: 'The spring snapped on the left panel.' }],
      },
    });
    const hits = search(db, 'spring');
    expect(hits.map((h) => h.id)).toContain('e1');
    expect(hits.find((h) => h.id === 'e1')!.snippet.toLowerCase()).toContain('spring');
  });

  test('a follow-up message is findable', () => {
    const db = seeded();
    save(db, {
      id: 'f1',
      kind: 'card',
      created_at: 4000,
      updated_at: 4000,
      channel_id: 'chan-general',
      card: {
        type: 'handover',
        title: 'Contractor research',
        status: 'info',
        follow_ups: [{ label: 'Send the invoice', message: 'Please email the contractor invoice to Dana.' }],
      },
    });
    const hits = search(db, 'contractor');
    expect(hits.map((h) => h.id)).toContain('f1');
    expect(hits.find((h) => h.id === 'f1')!.snippet.toLowerCase()).toContain('contractor');
  });

  test('a payment line item is findable', () => {
    const db = seeded();
    save(db, {
      id: 'p1',
      kind: 'card',
      created_at: 4000,
      updated_at: 4000,
      channel_id: 'chan-general',
      card: {
        type: 'payment',
        title: 'Acme Hardware',
        status: 'pending',
        merchant: 'Acme Hardware',
        line_items: [{ title: 'Galvanized nails', price_cents: 1200 }],
      },
    });
    const hits = search(db, 'galvanized');
    expect(hits.map((h) => h.id)).toContain('p1');
    expect(hits.find((h) => h.id === 'p1')!.snippet.toLowerCase()).toContain('galvanized');
  });

  test('a source quote is findable', () => {
    const db = seeded();
    save(db, {
      id: 's1',
      kind: 'card',
      created_at: 4000,
      updated_at: 4000,
      channel_id: 'chan-general',
      card: {
        type: 'note',
        title: 'Permit status',
        status: 'info',
        sources: [{ kind: 'url', label: 'City permit office', quote: 'Permit #4471 was issued on October 3rd.' }],
      },
    });
    const hits = search(db, '4471');
    expect(hits.map((h) => h.id)).toContain('s1');
    expect(hits.find((h) => h.id === 's1')!.snippet).toContain('4471');
  });

  test('a card saved before the subfield reindex becomes searchable after the upgrade', () => {
    const db = new Database(':memory:');
    // The v2 shape: the index knew only card.title and card.body, kept current by triggers.
    db.exec(`
      CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, run_id TEXT, task_id TEXT, channel_id TEXT DEFAULT 'chan-general', json TEXT NOT NULL);
      CREATE VIRTUAL TABLE fts_items USING fts5(item_id UNINDEXED, channel_id UNINDEXED, kind UNINDEXED, text, card_title, card_body, tokenize = 'porter unicode61');
      CREATE VIRTUAL TABLE fts_assets USING fts5(ref_id UNINDEXED, kind UNINDEXED, title, body, tokenize = 'porter unicode61');
      CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
        INSERT INTO fts_items(item_id, channel_id, kind, text, card_title, card_body)
        VALUES (new.id, coalesce(new.channel_id, 'chan-general'), new.kind, json_extract(new.json, '$.text'), json_extract(new.json, '$.card.title'), json_extract(new.json, '$.card.body'));
      END;
      PRAGMA user_version = 2;
    `);
    db.query('INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)').run(
      'old-card',
      'card',
      1,
      1,
      'chan-general',
      JSON.stringify({
        card: {
          type: 'approval',
          title: 'Roof repair',
          status: 'pending',
          body: 'The contractor sent an invoice.',
          draft: 'Please pay the roof deposit from the household account.',
        },
      }),
    );
    // The draft is invisible under the old index.
    expect(search(db, 'deposit')).toEqual([]);
    // The upgrade rebuilds the index from searchText.
    applySchema(db);
    const hits = search(db, 'deposit');
    expect(hits.map((h) => h.id)).toContain('old-card');
    expect(hits.find((h) => h.id === 'old-card')!.snippet.toLowerCase()).toContain('deposit');
  });
});
