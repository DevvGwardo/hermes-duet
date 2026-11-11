import { expect, test } from 'bun:test';
import type { Item, Settings } from '../shared/types';
import { localParts } from './clock';
import { attachments, channels, db, devices, files, items, kv, newId, pages, prune, runs, settings, tasks, toAttachment, triggers } from './db';
import { GENERAL_CHANNEL } from './schema';
import { search } from './search';

test('new ids are compact, sortable and unique', () => {
  const a = newId();
  const b = newId();
  expect(a).toMatch(/^[0-9a-z]{15}$/);
  expect(b).toMatch(/^[0-9a-z]{15}$/);
  expect(a).not.toBe(b);
  expect(b >= a).toBe(true);
  expect(new Set(Array.from({ length: 100 }, newId)).size).toBe(100);
});

test('kv returns the fallback for missing keys', () => {
  expect(kv.get('hc-missing-key', 'fb')).toBe('fb');
  expect(kv.get<number>('hc-missing-num', 7)).toBe(7);
});

test('kv round-trips objects', () => {
  kv.set('hc-obj', { a: 1, b: ['x'] });
  expect(kv.get<{ a: number; b: string[] } | null>('hc-obj', null)).toEqual({ a: 1, b: ['x'] });
});

test('kv survives a corrupt value instead of throwing', () => {
  db.query('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'hc-corrupt',
    'not-json{{{',
  );
  expect(kv.get('hc-corrupt', 'fb')).toBe('fb');
});

test('creating a name that is already a live channel does not erase its topic', () => {
  const first = channels.create({ name: 'hc-live', topic: 'still here' });
  const again = channels.create({ name: 'hc-live' });
  expect(again.id).toBe(first.id);
  expect(again.topic).toBe('still here');
});

test('an archived channel comes back under the same id, with the new topic', () => {
  const first = channels.create({ name: 'hc-arch', topic: 'old topic' });
  channels.archive(first.id);
  const back = channels.create({ name: 'hc-arch', topic: 'new topic' });
  expect(back.id).toBe(first.id);
  expect(back.topic).toBe('new topic');
  expect(back.archived_at ?? null).toBe(null);
});

test('reusing an archived channel without a topic keeps the one it had', () => {
  const first = channels.create({ name: 'hc-arch2', topic: 'kept' });
  channels.archive(first.id);
  expect(channels.create({ name: 'hc-arch2' }).topic).toBe('kept');
});

test('instructions and group round-trip through create, read and update', () => {
  const created = channels.create({ name: 'hc-rules', topic: 't', instructions: 'Be terse.', group: 'Work' });
  expect(created.instructions).toBe('Be terse.');
  expect(created.group).toBe('Work');
  expect(channels.get(created.id)).toMatchObject({ instructions: 'Be terse.', group: 'Work' });
  // The list query carries them too, so the strip can group without a second fetch.
  expect(channels.all().find((c) => c.id === created.id)).toMatchObject({ instructions: 'Be terse.', group: 'Work' });

  const updated = channels.update(created.id, { instructions: 'Be verbose.', group: null });
  expect(updated).toMatchObject({ instructions: 'Be verbose.', group: null, topic: 't' });

  // Absent keys leave the row alone; a null clears it back to nothing.
  expect(channels.update(created.id, {})?.instructions).toBe('Be verbose.');
  expect(channels.update(created.id, { instructions: null })?.instructions).toBeNull();
});

test('a repo round-trips through create, read and update', () => {
  // `ChannelInput` is the cleaned shape channelInput produces, so the repo arrives already normalized.
  const created = channels.create({ name: 'hc-repo', repo: 'https://github.com/owner/name' });
  expect(created.repo).toBe('https://github.com/owner/name');
  expect(channels.get(created.id)).toMatchObject({ repo: 'https://github.com/owner/name' });
  // The list query carries it too, so the sheet can show the link without a second fetch.
  expect(channels.all().find((c) => c.id === created.id)).toMatchObject({ repo: 'https://github.com/owner/name' });

  const updated = channels.update(created.id, { repo: 'https://github.com/other/project' });
  expect(updated?.repo).toBe('https://github.com/other/project');
  // Absent keys leave the repo alone.
  expect(channels.update(created.id, { topic: 'x' })?.repo).toBe('https://github.com/other/project');
  // A null clears it back to nothing.
  expect(channels.update(created.id, { repo: null })?.repo).toBeNull();
});

test('a channel created without a repo reads back as null', () => {
  const created = channels.create({ name: 'hc-norepo' });
  expect(created.repo ?? null).toBe(null);
  expect(channels.all().find((c) => c.id === created.id)?.repo ?? null).toBe(null);
});

test('a channel created before instructions and groups still reads back fine', () => {
  const created = channels.create({ name: 'hc-plain', topic: 'old style' });
  const row = channels.get(created.id)!;
  expect(row.topic).toBe('old style');
  expect(row.instructions ?? null).toBe(null);
  expect(row.group ?? null).toBe(null);
});

test('updating an unknown channel is a miss, not a throw', () => {
  expect(channels.update('chan-no-such', { topic: 'x' })).toBe(null);
});

// The search index is a second copy of a file's title, so every write has to move both. A rename that reached the
// row but not the index keeps the old title findable; an update for a file that isn't there puts a hit in search
// that opens a 404 in Make. Both are one unit of work, not two.
test('renaming a delivered file re-indexes it under the new title only', () => {
  const entry = { id: newId(), title: 'Statement alpha', name: 'statement.pdf', mime: 'application/pdf', size: 12, created_at: Date.now() };
  files.add(entry, '/tmp/hc-statement.pdf');
  files.update({ ...entry, title: 'Statement beta' });
  const hits = (q: string) => search(db, q).filter((h) => h.id === entry.id);
  expect(hits('beta')).toHaveLength(1);
  expect(hits('alpha')).toHaveLength(0);
});

test('updating a file the library does not have leaves no searchable ghost', () => {
  files.update({ id: 'hc-no-such-file', title: 'Ghost statement', name: 'ghost.pdf', mime: 'application/pdf', size: 1, created_at: Date.now() });
  expect(search(db, 'ghost').some((h) => h.id === 'hc-no-such-file')).toBe(false);
});

test('removing a page takes its search row with it', () => {
  const page = pages.save({ id: newId(), title: 'Retirement plan', instructions: 'Rebuild it.', file_id: 'f-hc', created_at: Date.now(), updated_at: Date.now() });
  expect(search(db, 'retirement').some((h) => h.id === page.id)).toBe(true);
  pages.remove(page.id);
  expect(search(db, 'retirement').some((h) => h.id === page.id)).toBe(false);
});

// Settings are one JSON blob, so a row saved before the notification preferences existed has no keys for them.
// The defaults must read as the behavior such an install already had: everything pushes, nothing muted, no cap.
test('an old settings row reads as the behavior it always had', () => {
  const before = kv.get<Partial<Settings> | null>('settings', null);
  try {
    kv.set('settings', { brief_enabled: false });
    const s = settings.get();
    expect(s.notify_tasks).toBe('all');
    expect(s.notify_agent).toBe(true);
    expect(s.muted_channels).toEqual([]);
    expect(s.max_pushes_per_day).toBe(0);
  } finally {
    kv.set('settings', before ?? {});
  }
});

test('settings.update validates the notification preferences and drops unknown channels', () => {
  const c = channels.create({ name: 'hc-mute' });
  const before = kv.get<Partial<Settings> | null>('settings', null);
  try {
    const next = settings.update({ notify_tasks: 'failures', notify_agent: false, muted_channels: [c.id, c.id, 'chan-nope'], max_pushes_per_day: 12 });
    expect(next.notify_tasks).toBe('failures');
    expect(next.notify_agent).toBe(false);
    expect(next.muted_channels).toEqual([c.id]);
    expect(next.max_pushes_per_day).toBe(12);
  } finally {
    kv.set('settings', before ?? {});
  }
});

test('settings.update refuses a bad notification preference instead of storing it', () => {
  expect(() => settings.update({ notify_tasks: 'sometimes' as any })).toThrow('notify_tasks');
  expect(() => settings.update({ notify_agent: 'yes' as any })).toThrow('notify_agent');
  expect(() => settings.update({ muted_channels: 'nope' as any })).toThrow('muted_channels');
  expect(() => settings.update({ max_pushes_per_day: -1 })).toThrow('max_pushes_per_day');
  expect(() => settings.update({ max_pushes_per_day: 101 })).toThrow('max_pushes_per_day');
  expect(() => settings.update({ max_pushes_per_day: 2.5 })).toThrow('max_pushes_per_day');
});

test('a task is searchable by its result and its source quote', () => {
  const task = {
    id: newId(),
    title: 'Permit research',
    status: 'done' as const,
    steps: [],
    result: 'The city issued permit #4471.',
    sources: [{ kind: 'url' as const, label: 'City permit office', quote: 'Permit #4471 was issued' }],
    created_at: Date.now(),
    updated_at: Date.now(),
    background: true,
  };
  tasks.save(task);
  expect(search(db, '4471').some((h) => h.id === task.id)).toBe(true);
  expect(search(db, 'permit').some((h) => h.id === task.id && h.kind === 'task')).toBe(true);
});

test('items pagination, setChannel, pendingCards, briefsSince, and channelOf work accurately', () => {
  const ch = channels.create({ name: `hc-items-${newId().slice(-6)}` });
  const ids: string[] = [];
  const putItem = (over: Partial<Item> & { id: string; created_at: number }) => {
    ids.push(over.id);
    items.save({
      kind: 'user',
      updated_at: over.created_at,
      ...over,
    });
  };
  try {
    putItem({ id: `dbi-1-${newId()}`, created_at: 10_000, channel_id: ch.id, text: 'first in ch' });
    putItem({ id: `dbi-2-${newId()}`, created_at: 20_000, channel_id: ch.id, text: 'second in ch' });
    putItem({ id: `dbi-3-${newId()}`, created_at: 30_000, channel_id: ch.id, text: 'third in ch' });
    putItem({
      id: `dbi-card-${newId()}`,
      kind: 'card',
      created_at: 25_000,
      channel_id: GENERAL_CHANNEL,
      card: { type: 'approval', title: 'Moveable card', status: 'pending', body: `moveabletoken${ids[0]}` },
    });
    putItem({
      id: `dbi-brief-${newId()}`,
      kind: 'card',
      created_at: 40_000,
      channel_id: GENERAL_CHANNEL,
      card: { type: 'brief', title: 'Brief', status: 'info' },
    });

    const latestPage = items.latest(2, ch.id);
    expect(latestPage.has_more).toBe(true);
    expect(latestPage.items.map((i) => i.id)).toEqual([ids[1], ids[2]]);

    const beforePage = items.before(ids[1]!, 5, ch.id);
    expect(beforePage.has_more).toBe(false);
    expect(beforePage.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(items.before('no-such-item', 10)).toEqual({ items: [], has_more: false });

    const cardId = ids[3]!;
    expect(items.pendingCards(ch.id).some((c) => c.id === cardId)).toBe(false);
    expect(items.channelOf(cardId)).toBe(GENERAL_CHANNEL);

    const moved = items.setChannel(cardId, ch.id);
    expect(moved?.channel_id).toBe(ch.id);
    expect(items.channelOf(cardId)).toBe(ch.id);
    expect(items.pendingCards(ch.id).some((c) => c.id === cardId)).toBe(true);
    expect(search(db, `moveabletoken${ids[0]}`).find((h) => h.id === cardId)?.channel_id).toBe(ch.id);

    const briefs = items.briefsSince(39_999);
    expect(briefs.some((b) => b.id === ids[4])).toBe(true);
    expect(items.channelOf('missing-item-id')).toBe(GENERAL_CHANNEL);
  } finally {
    for (const id of ids) db.query('DELETE FROM items WHERE id = ?').run(id);
  }
});

test('attachments add, get, link, and toAttachment kind mapping', () => {
  const imgId = `att-img-${newId()}`;
  const audId = `att-aud-${newId()}`;
  const docId = `att-doc-${newId()}`;
  try {
    const img = attachments.add({ id: imgId, filename: 'photo.jpg', mime: 'image/jpeg', size: 123, path: '/tmp/photo.jpg' });
    const aud = attachments.add({ id: audId, filename: 'memo.m4a', mime: 'audio/mp4', size: 456, path: '/tmp/memo.m4a' });
    const doc = attachments.add({ id: docId, filename: 'plan.pdf', mime: 'application/pdf', size: 789, path: '/tmp/plan.pdf' });
    expect(img.item_id).toBeNull();

    attachments.link([imgId, audId], 'item-parent-1');
    expect(attachments.get(imgId)?.item_id).toBe('item-parent-1');
    expect(attachments.get(audId)?.item_id).toBe('item-parent-1');
    expect(attachments.get(docId)?.item_id).toBeNull();
    expect(attachments.get('missing-att')).toBeNull();

    expect(toAttachment(img).kind).toBe('image');
    expect(toAttachment(aud).kind).toBe('audio');
    expect(toAttachment(doc).kind).toBe('file');
  } finally {
    for (const id of [imgId, audId, docId]) db.query('DELETE FROM attachments WHERE id = ?').run(id);
  }
});

test('files.all caps at 200 rows ordered newest first', () => {
  const added: string[] = [];
  const baseTs = Date.now() + 10_000_000;
  try {
    for (let i = 0; i < 205; i++) {
      const id = `hc-cap-file-${String(i).padStart(3, '0')}-${newId()}`;
      added.push(id);
      files.add(
        { id, title: `File ${i}`, name: `file-${i}.md`, mime: 'text/markdown', size: 4, created_at: baseTs + i },
        `/tmp/${id}.md`,
      );
    }
    const list = files.all();
    expect(list).toHaveLength(200);
    expect(list[0]!.id).toBe(added[204]);
    expect(list[199]!.id).toBe(added[5]);
    expect(list.some((f) => f.id === added[0])).toBe(false);
  } finally {
    for (const id of added) {
      db.query('DELETE FROM files WHERE id = ?').run(id);
      db.query('DELETE FROM fts_assets WHERE ref_id = ?').run(id);
    }
  }
});

test('runs lifecycle, orphaned ordering DESC, and prune cleanup', () => {
  const session = `sess-${newId()}`;
  const rOldDone = `run-old-done-${newId()}`;
  const rRecentDone = `run-recent-done-${newId()}`;
  const rOrphanEarlier = `run-orphan-1-${newId()}`;
  const rOrphanLater = `run-orphan-2-${newId()}`;
  const expiredCode = `code-exp-${newId()}`;
  const freshCode = `code-fresh-${newId()}`;
  const now = Date.now();
  const fortyDaysAgo = now - 40 * 86400_000;

  try {
    runs.start(rOldDone, 'chat', session, null, { step: 1 });
    runs.meta(rOldDone, { step: 2 });
    runs.end(rOldDone, 'done');
    // abandon ignores already-ended runs
    runs.abandon(rOldDone, 'should not overwrite');
    expect(db.query<{ status: string; error: string | null }, [string]>('SELECT status, error FROM runs WHERE id = ?').get(rOldDone)).toEqual({
      status: 'done',
      error: null,
    });
    db.query('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?').run(fortyDaysAgo - 1000, fortyDaysAgo, rOldDone);

    runs.start(rRecentDone, 'chat', session, null, {});
    runs.end(rRecentDone, 'error', 'boom');

    db.query('INSERT INTO runs(id, kind, session_id, task_id, status, started_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      rOrphanEarlier,
      'task',
      session,
      null,
      'running',
      fortyDaysAgo,
      '{}',
    );
    db.query('INSERT INTO runs(id, kind, session_id, task_id, status, started_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      rOrphanLater,
      'task',
      session,
      null,
      'running',
      now - 1000,
      '{}',
    );

    const orphaned = runs.orphaned().filter((r) => r.session_id === session);
    expect(orphaned.map((r) => r.id)).toEqual([rOrphanLater, rOrphanEarlier]);

    expect(runs.recentFor(session, 2).map((r) => r.id)).toHaveLength(2);

    db.query('INSERT INTO pair_codes(code, expires_at) VALUES (?, ?)').run(expiredCode, now - 1000);
    db.query('INSERT INTO pair_codes(code, expires_at) VALUES (?, ?)').run(freshCode, now + 60_000);

    const pruned = prune(now);
    expect(pruned.runs).toBeGreaterThanOrEqual(1);
    expect(pruned.codes).toBeGreaterThanOrEqual(1);
    // Completed run >30d old deleted; recent completed run & running runs (even old) kept.
    expect(db.query<{ id: string }, [string]>('SELECT id FROM runs WHERE id = ?').get(rOldDone)).toBeNull();
    expect(db.query<{ id: string }, [string]>('SELECT id FROM runs WHERE id = ?').get(rRecentDone)).not.toBeNull();
    expect(db.query<{ id: string }, [string]>('SELECT id FROM runs WHERE id = ?').get(rOrphanEarlier)).not.toBeNull();
    expect(db.query<{ code: string }, [string]>('SELECT code FROM pair_codes WHERE code = ?').get(expiredCode)).toBeNull();
    expect(db.query<{ code: string }, [string]>('SELECT code FROM pair_codes WHERE code = ?').get(freshCode)).not.toBeNull();

    runs.abandon(rOrphanLater, 'crashed');
    expect(db.query<{ status: string; error: string | null }, [string]>('SELECT status, error FROM runs WHERE id = ?').get(rOrphanLater)).toEqual({
      status: 'error',
      error: 'crashed',
    });
  } finally {
    for (const id of [rOldDone, rRecentDone, rOrphanEarlier, rOrphanLater]) db.query('DELETE FROM runs WHERE id = ?').run(id);
    for (const c of [expiredCode, freshCode]) db.query('DELETE FROM pair_codes WHERE code = ?').run(c);
  }
});

test('devices.revoke atomically removes device and its push subscriptions', () => {
  const dev1 = `dev-rev-1-${newId()}`;
  const dev2 = `dev-rev-2-${newId()}`;
  const ep1 = `https://push.example/rev-1-${newId()}`;
  const ep2 = `https://push.example/rev-2-${newId()}`;
  const now = Date.now();
  try {
    db.query('INSERT INTO devices(id, token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(dev1, `hash-${dev1}`, 'Phone', now, now);
    db.query('INSERT INTO devices(id, token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(dev2, `hash-${dev2}`, 'Tablet', now, now);
    db.query('INSERT INTO push_subs(endpoint, json, device_id, created_at) VALUES (?, ?, ?, ?)').run(ep1, '{}', dev1, now);
    db.query('INSERT INTO push_subs(endpoint, json, device_id, created_at) VALUES (?, ?, ?, ?)').run(ep2, '{}', dev2, now);

    expect(devices.all().some((d) => d.id === dev1)).toBe(true);
    expect(devices.revoke('no-such-device')).toBe(false);
    expect(devices.revoke(dev1)).toBe(true);
    expect(devices.revoke(dev1)).toBe(false);

    expect(devices.all().some((d) => d.id === dev1)).toBe(false);
    expect(db.query<{ endpoint: string }, [string]>('SELECT endpoint FROM push_subs WHERE endpoint = ?').get(ep1)).toBeNull();
    expect(devices.all().some((d) => d.id === dev2)).toBe(true);
    expect(db.query<{ endpoint: string }, [string]>('SELECT endpoint FROM push_subs WHERE endpoint = ?').get(ep2)?.endpoint).toBe(ep2);
  } finally {
    db.query('DELETE FROM push_subs WHERE endpoint IN (?, ?)').run(ep1, ep2);
    db.query('DELETE FROM devices WHERE id IN (?, ?)').run(dev1, dev2);
  }
});

test('triggers save and touch persist config and last_triggered_at', () => {
  const id = `trig-db-${newId()}`;
  try {
    triggers.save({ id, kind: 'webhook', config: { name: 'github' }, enabled: true, created_at: 1000 });
    expect(triggers.all().find((t) => t.id === id)).toMatchObject({ id, kind: 'webhook', enabled: 1, last_triggered_at: null });
    triggers.touch(id, 5555);
    expect(triggers.all().find((t) => t.id === id)?.last_triggered_at).toBe(5555);
  } finally {
    db.query('DELETE FROM triggers WHERE id = ?').run(id);
  }
});

test('settings.get and settings.update sanitize corrupt or invalid timezones', () => {
  const before = kv.get<Partial<Settings> | null>('settings', null);
  try {
    kv.set('settings', { timezone: 'Mars/Olympus_Mons' });
    const s = settings.get();
    expect(s.timezone).not.toBe('Mars/Olympus_Mons');
    expect(() => localParts(s.timezone)).not.toThrow();

    const updated = settings.update({ timezone: 'Not/A_Real_Zone' });
    expect(updated.timezone).not.toBe('Not/A_Real_Zone');
    expect(() => localParts(updated.timezone)).not.toThrow();

    const valid = settings.update({ timezone: 'America/New_York' });
    expect(valid.timezone).toBe('America/New_York');
  } finally {
    kv.set('settings', before ?? {});
  }
});

test('channels.forTask keeps live channels and falls back to general for archived or missing channels', () => {
  const generalId = channels.general().id;
  const ch = channels.create({ name: `hc-fortask-${newId().slice(-6)}` });
  const baseTask = { id: `t-${newId()}`, title: 'Check', status: 'running' as const, steps: [], created_at: 1, updated_at: 1, background: true };

  expect(channels.forTask(undefined)).toBe(generalId);
  expect(channels.forTask({ ...baseTask, channel_id: 'chan-missing' })).toBe(generalId);
  expect(channels.forTask({ ...baseTask, channel_id: ch.id })).toBe(ch.id);

  channels.archive(ch.id);
  expect(channels.get(ch.id)?.archived_at).not.toBeNull();
  expect(channels.forTask({ ...baseTask, channel_id: ch.id })).toBe(generalId);
});
