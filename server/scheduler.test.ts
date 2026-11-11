import { afterEach, expect, spyOn, test } from 'bun:test';
import webpush from 'web-push';
import type { Item, Page, Routine, Settings, Task } from '../shared/types';
import { config } from './config';
import { db, items, kv, newId, pages, routines, settings, tasks } from './db';
import { saveSubscription } from './push';
import { __resetBriefHeld, runDueRoutines, schedulerTick, startScheduler } from './scheduler';

const ORIG_SETTINGS: Settings = settings.get();
const ORIG_HELD = kv.get<any[]>('push_held', []);
const ORIG_BRIEF_DATE = kv.get<string>('brief_last_date', '');
const ORIG_CHECKIN_SLOT = kv.get<string>('checkin_last_slot', '');
const ORIG_DISABLE_SCHEDULER = process.env.DUET_DISABLE_SCHEDULER;
const ORIG_PUBLIC_URL = config.publicUrl;

const createdRoutineIds: string[] = [];
const createdPageIds: string[] = [];
const createdTaskIds: string[] = [];
const createdItemIds: string[] = [];
const createdEndpoints: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  __resetBriefHeld();
  settings.update(ORIG_SETTINGS);
  kv.set('push_held', ORIG_HELD);
  kv.set('brief_last_date', ORIG_BRIEF_DATE);
  kv.set('checkin_last_slot', ORIG_CHECKIN_SLOT);
  (config as { publicUrl: string }).publicUrl = ORIG_PUBLIC_URL;
  if (ORIG_DISABLE_SCHEDULER === undefined) delete process.env.DUET_DISABLE_SCHEDULER;
  else process.env.DUET_DISABLE_SCHEDULER = ORIG_DISABLE_SCHEDULER;

  for (const id of createdRoutineIds.splice(0)) routines.remove(id);
  for (const id of createdPageIds.splice(0)) pages.remove(id);
  for (const id of createdTaskIds.splice(0)) db.query('DELETE FROM tasks WHERE id = ?').run(id);
  for (const id of createdItemIds.splice(0)) db.query('DELETE FROM items WHERE id = ?').run(id);
  for (const ep of createdEndpoints.splice(0)) db.query('DELETE FROM push_subs WHERE endpoint = ?').run(ep);
});

const UTC_SETTINGS: Settings = {
  ...ORIG_SETTINGS,
  timezone: 'UTC',
  brief_enabled: true,
  brief_time: '08:00',
  checkins: 'off',
  quiet_start: '00:00',
  quiet_end: '00:00',
};

test('disabled scheduler starts nothing and returns', () => {
  expect(process.env.DUET_DISABLE_SCHEDULER).toBe('1');
  expect(startScheduler()).toBeUndefined();
});

test('starting the disabled scheduler twice is safe', () => {
  expect(() => {
    startScheduler();
    startScheduler();
  }).not.toThrow();
});

test('runDueRoutines advances schedule and records launch failure on missing channel', () => {
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  spies.push(errSpy);
  settings.update(UTC_SETTINGS);
  const now = Date.UTC(2026, 10, 12, 9, 0, 0);
  const r: Routine = {
    id: newId(),
    title: 'Broken channel routine',
    prompt: 'Do something.',
    schedule: { kind: 'daily', time: '09:00' },
    channel_id: 'chan-does-not-exist',
    enabled: true,
    next_run: now - 5_000,
    created_at: now - 60_000,
    updated_at: now - 60_000,
  };
  routines.save(r);
  createdRoutineIds.push(r.id);

  runDueRoutines(now);

  const after = routines.get(r.id)!;
  expect(after.next_run!).toBeGreaterThan(now);
  expect(after.last_result).toContain("Couldn't start:");
  expect(errSpy).toHaveBeenCalled();
});

test('schedulerTick holds pushes during quiet hours and sends Away summary after quiet ends', async () => {
  const endpoint = `https://push.example.test/${newId()}`;
  createdEndpoints.push(endpoint);
  saveSubscription(
    {
      endpoint,
      keys: { p256dh: 'BOr7j3m2pK1nV4w6y8A0c2E4g6i8k0m2o4q6s8u0w2y4A6c8e0g2i4k6m8o0q2s4u6w8y0A2c4e6g8i0k2m4', auth: 'abc123def456' },
    },
    'dev-sched',
  );
  const cardItem: Item = {
    id: newId(),
    kind: 'card',
    created_at: Date.now(),
    updated_at: Date.now(),
    run_id: null,
    task_id: null,
    card: { type: 'choice', title: 'Confirm slot', options: ['Yes', 'No'], status: 'pending' },
  };
  items.save(cardItem);
  createdItemIds.push(cardItem.id);

  kv.set('push_held', [{ card_id: cardItem.id, line: 'Quick question: Confirm slot', at: Date.now() - 10_000 }]);
  kv.set('brief_last_date', '2026-11-12');

  const sendSpy = spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, headers: {}, body: '' } as any);
  spies.push(sendSpy);
  (config as { publicUrl: string }).publicUrl = 'https://duet.example.test';

  // Inside quiet hours (02:00 UTC in 01:00..05:00): held pushes remain untouched.
  settings.update({ ...UTC_SETTINGS, quiet_start: '01:00', quiet_end: '05:00' });
  schedulerTick(Date.UTC(2026, 10, 12, 2, 0, 0));
  expect(kv.get<any[]>('push_held', []).length).toBe(1);
  expect(sendSpy).not.toHaveBeenCalled();

  // Within 60 min before due brief (07:30 UTC for 08:00 brief, brief not yet sent today): cleared without extra push.
  kv.set('brief_last_date', '');
  settings.update({ ...UTC_SETTINGS, quiet_start: '00:00', quiet_end: '00:00', brief_time: '08:00' });
  schedulerTick(Date.UTC(2026, 10, 12, 7, 30, 0));
  expect(kv.get<any[]>('push_held', [])).toEqual([]);
  expect(sendSpy).not.toHaveBeenCalled();

  // Outside quiet hours and after today's brief: held pushes flush as one "While you were away" notification.
  kv.set('push_held', [{ card_id: cardItem.id, line: 'Quick question: Confirm slot', at: Date.now() - 10_000 }]);
  kv.set('brief_last_date', '2026-11-12');
  schedulerTick(Date.UTC(2026, 10, 12, 10, 0, 0));
  await new Promise((r) => setTimeout(r, 20));
  expect(kv.get<any[]>('push_held', [])).toEqual([]);
  const mine = sendSpy.mock.calls.filter((c) => (c[0] as { endpoint?: string } | undefined)?.endpoint === endpoint);
  expect(mine.length).toBe(1);
  const payload = JSON.parse(String(mine[0]?.[1] ?? '{}'));
  expect(payload.title).toBe('While you were away');
  expect(payload.body).toContain('Quick question: Confirm slot');
});

test('schedulerTick refreshes due standing pages and holds due brief until refresh finishes', () => {
  const beforeItemIds = new Set(items.latest(200).items.map((i) => i.id));
  const beforeTaskIds = new Set(tasks.recent().map((t) => t.id));
  const now = Date.UTC(2026, 10, 12, 8, 5, 0);
  const refreshTask: Task = {
    id: newId(),
    title: 'Refresh: Metrics',
    status: 'running',
    steps: [],
    created_at: now - 120_000,
    updated_at: now - 10_000,
    background: true,
  };
  tasks.save(refreshTask);
  createdTaskIds.push(refreshTask.id);

  const pageBusy: Page = {
    id: newId(),
    title: 'Metrics',
    instructions: 'Rebuild metrics.',
    file_id: 'f-missing',
    refreshed_on: '2026-11-12',
    task_id: refreshTask.id,
    created_at: now - 86_400_000,
    updated_at: now - 10_000,
  };
  pages.save(pageBusy);
  createdPageIds.push(pageBusy.id);

  // Another standing page was last refreshed yesterday and becomes due at 07:30 for an 08:00 brief.
  const pageDue: Page = {
    id: newId(),
    title: 'Pipeline',
    instructions: 'Rebuild pipeline.',
    file_id: 'f-missing-2',
    refreshed_on: '2026-11-11',
    created_at: now - 86_400_000,
    updated_at: now - 86_400_000,
  };
  pages.save(pageDue);
  createdPageIds.push(pageDue.id);

  settings.update({ ...UTC_SETTINGS, brief_time: '08:00', checkins: 'off' });
  kv.set('brief_last_date', '');

  // First tick: starts pageDue refresh AND holds brief while pageBusy is still running.
  schedulerTick(now);
  const refreshed = pages.get(pageDue.id)!;
  expect(refreshed.refreshed_on).toBe('2026-11-12');
  expect(refreshed.task_id).toBeTruthy();
  if (refreshed.task_id) createdTaskIds.push(refreshed.task_id);
  expect(kv.get('brief_last_date', '')).toBe('');

  // Finish both refresh tasks so the next tick releases the held brief.
  tasks.save({ ...refreshTask, status: 'done' });
  if (refreshed.task_id) {
    const rt = tasks.get(refreshed.task_id);
    if (rt) tasks.save({ ...rt, status: 'done' });
  }
  schedulerTick(now + 30_000);
  expect(kv.get('brief_last_date', '')).toBe('2026-11-12');

  for (const t of tasks.recent()) if (!beforeTaskIds.has(t.id)) createdTaskIds.push(t.id);
  for (const i of items.latest(200).items) if (!beforeItemIds.has(i.id)) createdItemIds.push(i.id);
});

test('schedulerTick honors 3x check-in slots, quiet hours, early briefs, and error recovery', () => {
  const beforeItemIds = new Set(items.latest(200).items.map((i) => i.id));
  settings.update({ ...UTC_SETTINGS, checkins: '3x', brief_time: '08:00', quiet_start: '22:00', quiet_end: '07:00' });

  // Before today's brief runs ('early'), check-ins wait even during a valid afternoon/morning window.
  kv.set('brief_last_date', '');
  kv.set('checkin_last_slot', '');
  schedulerTick(Date.UTC(2026, 10, 12, 7, 5, 0));
  expect(kv.get('checkin_last_slot', '')).toBe('');

  // Once today's brief is marked sent, 11:10 UTC triggers the 11:00 slot once.
  kv.set('brief_last_date', '2026-11-12');
  schedulerTick(Date.UTC(2026, 10, 12, 11, 10, 0));
  expect(kv.get('checkin_last_slot', '')).toBe('2026-11-12 11:00');

  // Calling again in quiet hours does not record a 22:00/later slot.
  schedulerTick(Date.UTC(2026, 10, 12, 22, 10, 0));
  expect(kv.get('checkin_last_slot', '')).toBe('2026-11-12 11:00');

  // If settings.get throws inside a tick, schedulerTick catches and logs instead of crashing.
  const errSpy = spyOn(console, 'error').mockImplementation(() => {});
  const settingsSpy = spyOn(settings, 'get').mockImplementation(() => {
    throw new Error('db hiccup');
  });
  spies.push(errSpy, settingsSpy);
  expect(() => schedulerTick(Date.UTC(2026, 10, 12, 14, 10, 0))).not.toThrow();
  expect(errSpy).toHaveBeenCalled();

  for (const i of items.latest(200).items) if (!beforeItemIds.has(i.id)) createdItemIds.push(i.id);
});

test('startScheduler schedules interval and initial timer when scheduler is enabled', () => {
  delete process.env.DUET_DISABLE_SCHEDULER;
  const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation((() => 1 as any) as any);
  const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation((() => 2 as any) as any);
  spies.push(intervalSpy, timeoutSpy);

  startScheduler();

  expect(intervalSpy).toHaveBeenCalledTimes(1);
  expect(intervalSpy.mock.calls[0]?.[1]).toBe(30_000);
  expect(timeoutSpy).toHaveBeenCalledTimes(1);
  expect(timeoutSpy.mock.calls[0]?.[1]).toBe(5_000);
});
