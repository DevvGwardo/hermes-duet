import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import webpush from 'web-push';
import type { Settings } from '../shared/types';
import { localParts } from './clock';
import { channels, db, kv, newId } from './db';
import { type HeldPush } from './held';
import type { SentDay } from './notify-prefs';
import { presence } from './presence';
import { hasSubscriptions, notify, saveSubscription } from './push';

test('saveSubscription rejects malformed subscriptions before touching the db', () => {
  expect(() => saveSubscription(null, 'd1')).toThrow('bad subscription');
  expect(() => saveSubscription({}, 'd1')).toThrow('bad subscription');
  expect(() => saveSubscription({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } }, 'd1')).toThrow('bad endpoint');
  expect(() => saveSubscription({ endpoint: 'https://x', keys: { p256dh: 'a' } }, 'd1')).toThrow('bad subscription');
});

test('fresh test db starts with no push subscriptions', () => {
  expect(hasSubscriptions()).toBe(false);
  expect(hasSubscriptions('no-such-device')).toBe(false);
});

test('saveSubscription stores a well-formed subscription and reports it', () => {
  saveSubscription({ endpoint: 'https://push.example/sub-1', keys: { p256dh: 'k1', auth: 'a1' } }, 'dev-1');
  expect(hasSubscriptions()).toBe(true);
  expect(hasSubscriptions('dev-1')).toBe(true);
  expect(hasSubscriptions('other-device')).toBe(false);
});

describe('notify', () => {
  const origSend = webpush.sendNotification;
  let savedSettings: Partial<Settings> | null = null;
  let savedSentDay: SentDay | null = null;
  let savedHeld: HeldPush[] | null = null;
  let savedSubs: { endpoint: string; json: string; device_id: string | null; created_at: number }[] = [];
  const createdItemIds: string[] = [];
  const presenceCleanups: Array<() => void> = [];

  const sub = (tag: string, deviceId = `dev-${tag}-${newId()}`) => {
    const endpoint = `https://push.example/${tag}-${newId()}`;
    saveSubscription({ endpoint, keys: { p256dh: `k-${tag}`, auth: `a-${tag}` } }, deviceId);
    return { endpoint, deviceId };
  };

  beforeEach(() => {
    savedSettings = kv.get<Partial<Settings> | null>('settings', null);
    savedSentDay = kv.get<SentDay | null>('push_sent_day', null);
    savedHeld = kv.get<HeldPush[] | null>('push_held', null);
    savedSubs = db.query<{ endpoint: string; json: string; device_id: string | null; created_at: number }, []>(
      'SELECT endpoint, json, device_id, created_at FROM push_subs',
    ).all();
    db.query('DELETE FROM push_subs').run();
    // Keep wall-clock non-quiet by default (`start === end` means quiet hours are off) in UTC.
    kv.set('settings', {
      ...(savedSettings ?? {}),
      timezone: 'UTC',
      quiet_start: '00:00',
      quiet_end: '00:00',
      notify_agent: true,
      notify_tasks: 'all',
      muted_channels: [],
      max_pushes_per_day: 0,
    });
    kv.set('push_sent_day', null);
    kv.set('push_held', []);
  });

  afterEach(() => {
    webpush.sendNotification = origSend;
    while (presenceCleanups.length) presenceCleanups.pop()!();
    while (createdItemIds.length) db.query('DELETE FROM items WHERE id = ?').run(createdItemIds.pop()!);
    db.query('DELETE FROM push_subs').run();
    for (const row of savedSubs) {
      db.query('INSERT INTO push_subs(endpoint, json, device_id, created_at) VALUES (?, ?, ?, ?)').run(
        row.endpoint,
        row.json,
        row.device_id,
        row.created_at,
      );
    }
    kv.set('settings', savedSettings ?? {});
    kv.set('push_sent_day', savedSentDay);
    kv.set('push_held', savedHeld ?? []);
  });

  test('carries badge and askMarks including pending payment card ids', async () => {
    sub('pay');
    const cardId = `pay-${newId()}`;
    createdItemIds.push(cardId);
    const now = Date.now();
    db.query('INSERT INTO items(id, kind, created_at, updated_at, channel_id, json) VALUES (?, ?, ?, ?, ?, ?)').run(
      cardId,
      'card',
      now,
      now,
      'chan-general',
      JSON.stringify({
        id: cardId,
        kind: 'card',
        created_at: now,
        updated_at: now,
        card: { type: 'payment', title: 'Hardware order', status: 'pending', merchant: 'Acme', amount_cents: 4200 },
      }),
    );

    const payloads: any[] = [];
    webpush.sendNotification = (async (_s, data) => {
      payloads.push(JSON.parse(String(data)));
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    const sent = await notify({ title: 'Check before I spend', body: '$42 at Acme', card_id: cardId, category: 'approval' });
    expect(sent).toBe(1);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].ask).toBe(true);
    expect(payloads[0].open).toContain(cardId);
    expect(payloads[0].badge).toBeGreaterThanOrEqual(1);
  });

  test('removes 404 and 410 subscriptions while preserving transient 500 subscriptions', async () => {
    const s404 = sub('404');
    const s410 = sub('410');
    const s500 = sub('500');

    webpush.sendNotification = (async (target: any) => {
      if (target.endpoint === s404.endpoint) throw { statusCode: 404 };
      if (target.endpoint === s410.endpoint) throw { statusCode: 410 };
      throw { statusCode: 500, body: 'retry later' };
    }) as typeof webpush.sendNotification;

    const sent = await notify({ title: 'Ping', body: 'test', category: 'system' });
    expect(sent).toBe(0);

    const remaining = db.query<{ endpoint: string }, []>('SELECT endpoint FROM push_subs').all().map((r) => r.endpoint);
    expect(remaining).toEqual([s500.endpoint]);
  });

  test('skips visible devices unless always is true', async () => {
    const vis = sub('vis', `dev-vis-${newId()}`);
    const bg = sub('bg', `dev-bg-${newId()}`);
    presence.report(vis.deviceId, 'client-1', true);
    presenceCleanups.push(() => presence.report(vis.deviceId, 'client-1', false));

    const delivered: string[] = [];
    webpush.sendNotification = (async (target: any) => {
      delivered.push(target.endpoint);
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    expect(await notify({ title: 'Update', body: 'normal', category: 'system' })).toBe(1);
    expect(delivered).toEqual([bg.endpoint]);

    delivered.length = 0;
    expect(await notify({ title: 'Urgent', body: 'always', category: 'system', always: true })).toBe(2);
    expect(delivered.sort()).toEqual([bg.endpoint, vis.endpoint].sort());
  });

  test('holds card pushes during quiet hours unless ignoreQuiet is set', async () => {
    sub('quiet');
    const mins = localParts('UTC', new Date()).minutes;
    const fmt = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
    kv.set('settings', {
      ...kv.get<Partial<Settings>>('settings', {}),
      timezone: 'UTC',
      quiet_start: fmt(mins - 30),
      quiet_end: fmt(mins + 30),
    });

    let sentCalls = 0;
    webpush.sendNotification = (async () => {
      sentCalls++;
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    const heldCardId = `held-${newId()}`;
    expect(await notify({ title: 'Quiet note', body: 'later', card_id: heldCardId, category: 'agent' })).toBe(0);
    expect(sentCalls).toBe(0);
    const held = kv.get<HeldPush[]>('push_held', []);
    expect(held.map((h) => h.card_id)).toEqual([heldCardId]);

    expect(await notify({ title: 'Wake note', body: 'now', card_id: heldCardId, category: 'agent' }, { ignoreQuiet: true })).toBe(1);
    expect(sentCalls).toBe(1);
  });

  test('respects notify_agent and muted_channels while exempting approvals', async () => {
    sub('prefs');
    const muted = channels.create({ name: `push-mute-${newId().slice(-6)}` });
    kv.set('settings', {
      ...kv.get<Partial<Settings>>('settings', {}),
      notify_agent: false,
      muted_channels: [muted.id],
      max_pushes_per_day: 2,
    });

    let sentCalls = 0;
    webpush.sendNotification = (async () => {
      sentCalls++;
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    expect(await notify({ title: 'Agent alert', body: 'suppressed', category: 'agent' })).toBe(0);
    expect(await notify({ title: 'Task finished', body: 'muted ch', category: 'task_done', channel_id: muted.id })).toBe(0);
    // Approvals ignore muted channels AND never consume daily budget.
    expect(await notify({ title: 'Needs your OK', body: 'approve', category: 'approval', channel_id: muted.id })).toBe(1);
    expect(sentCalls).toBe(1);
    expect(kv.get<SentDay | null>('push_sent_day', null)).toBeNull();
  });

  test('enforces daily push cap across sequential calls and releases budget when 0 delivered', async () => {
    sub('cap');
    kv.set('settings', {
      ...kv.get<Partial<Settings>>('settings', {}),
      max_pushes_per_day: 2,
    });

    let failAll = true;
    webpush.sendNotification = (async () => {
      if (failAll) throw { statusCode: 500, body: 'down' };
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    // Transient failures deliver 0, so the reserved budget slot must be released.
    expect(await notify({ title: 'Fail', body: '0', category: 'system' })).toBe(0);
    expect(kv.get<SentDay | null>('push_sent_day', null)?.count ?? 0).toBe(0);

    failAll = false;
    expect(await notify({ title: 'First', body: '1', category: 'system' })).toBe(1);
    expect(await notify({ title: 'Second', body: '2', category: 'system' })).toBe(1);
    expect(kv.get<SentDay | null>('push_sent_day', null)?.count).toBe(2);

    // 3rd non-exempt push hits the cap without sending or bumping past 2.
    expect(await notify({ title: 'Third', body: '3', category: 'system' })).toBe(0);
    expect(kv.get<SentDay | null>('push_sent_day', null)?.count).toBe(2);
  });

  test('prevents TOCTOU race past daily cap when concurrent notify calls overlap async I/O', async () => {
    sub('race');
    kv.set('settings', {
      ...kv.get<Partial<Settings>>('settings', {}),
      max_pushes_per_day: 2,
    });

    let delivered = 0;
    webpush.sendNotification = (async () => {
      await Bun.sleep(15);
      delivered++;
      return { statusCode: 201, body: '', headers: {} };
    }) as typeof webpush.sendNotification;

    const results = await Promise.all([
      notify({ title: 'R1', body: '1', category: 'system' }),
      notify({ title: 'R2', body: '2', category: 'system' }),
      notify({ title: 'R3', body: '3', category: 'system' }),
      notify({ title: 'R4', body: '4', category: 'system' }),
      notify({ title: 'R5', body: '5', category: 'system' }),
    ]);

    expect(delivered).toBe(2);
    expect(results.reduce((a, b) => a + b, 0)).toBe(2);
    expect(results.filter((n) => n === 1)).toHaveLength(2);
    expect(results.filter((n) => n === 0)).toHaveLength(3);
    expect(kv.get<SentDay | null>('push_sent_day', null)?.count).toBe(2);
  });
});
