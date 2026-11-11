import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Settings } from '../shared/types';
import { config } from './config';
import { db, kv, settings, triggers } from './db';
import { WEBHOOK_IP_MAX, WEBHOOK_IP_WINDOW_MS } from './triggers';
import {
  type FolderWatchState,
  checkMeetings,
  folderWatchPass,
  meetingPrepEnabled,
  meetingsToPrep,
  newWebhookToken,
  recordWebhook,
  recordWebhookIp,
  startFolderWatch,
  webhookIpReady,
  webhookReady,
  webhookToken,
} from './triggers-runtime';

const ORIG_IP_HITS = kv.get<Record<string, number[]>>('webhook_ip_hits', {});
const ORIG_SETTINGS: Settings = settings.get();
const ORIG_WATCH_DIR = config.watchDir;
const ORIG_LEAD = config.meetingLeadMinutes;
const tempDirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
  kv.set('webhook_ip_hits', ORIG_IP_HITS);
  settings.update(ORIG_SETTINGS);
  (config as { watchDir: string }).watchDir = ORIG_WATCH_DIR;
  (config as { meetingLeadMinutes: number }).meetingLeadMinutes = ORIG_LEAD;
  db.query("DELETE FROM triggers WHERE id = 'trigger-downloads'").run();
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test('webhook tokens are long, url-safe and unique', () => {
  const a = newWebhookToken();
  const b = newWebhookToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(b).toMatch(/^[A-Za-z0-9_-]{24}$/);
  expect(a).not.toBe(b);
});

test('webhook token persists once created', () => {
  const t1 = webhookToken();
  const t2 = webhookToken();
  expect(t1.length).toBeGreaterThan(16);
  expect(t2).toBe(t1);
});

test('one webhook record stays under the runaway cap', () => {
  expect(webhookReady()).toBe(true);
  expect(() => recordWebhook()).not.toThrow();
  expect(webhookReady()).toBe(true);
});

test('a meeting entering the lead window preps once, then is suppressed', () => {
  const now = Date.now();
  const events = [{ title: 'Duet Sync Alpha', start: now + 5 * 60_000, end: now + 35 * 60_000 }];
  expect(meetingsToPrep(events, now).map((e) => e.title)).toEqual(['Duet Sync Alpha']);
  expect(meetingsToPrep(events, now)).toEqual([]);
});

test('started and far-future meetings never prep', () => {
  const now = Date.now();
  const events = [
    { title: 'Duet Past Beta', start: now - 60_000, end: now + 1_800_000 },
    { title: 'Duet Far Gamma', start: now + 48 * 3_600_000, end: now + 49 * 3_600_000 },
  ];
  expect(meetingsToPrep(events, now)).toEqual([]);
});

test('webhookIpReady enforces per-IP limits inside the minute window and recovers afterwards', () => {
  kv.set('webhook_ip_hits', {});
  const t0 = 10_000_000;
  for (let i = 0; i < WEBHOOK_IP_MAX - 1; i++) {
    expect(webhookIpReady('203.0.113.1', t0 + i * 100)).toBe(true);
    recordWebhookIp('203.0.113.1', t0 + i * 100);
  }
  expect(webhookIpReady('203.0.113.1', t0 + 5_000)).toBe(true);
  recordWebhookIp('203.0.113.1', t0 + 5_000);
  expect(webhookIpReady('203.0.113.1', t0 + 5_001)).toBe(false);
  // Another source IP is unaffected, and the blocked IP recovers once the window slides past all hits.
  expect(webhookIpReady('203.0.113.2', t0 + 5_001)).toBe(true);
  expect(webhookIpReady('203.0.113.1', t0 + 5_000 + WEBHOOK_IP_WINDOW_MS + 1)).toBe(true);
});

test('recordWebhookIp prunes expired buckets before applying the 64-key bound', () => {
  kv.set('webhook_ip_hits', {});
  const t0 = 20_000_000;
  for (let i = 0; i < 64; i++) {
    recordWebhookIp(`198.51.100.${i}`, t0);
  }
  expect(Object.keys(kv.get<Record<string, number[]>>('webhook_ip_hits', {})).length).toBe(64);
  // Once those 64 entries expire, recording one fresh IP prunes them all instead of retaining stale buckets.
  const later = t0 + WEBHOOK_IP_WINDOW_MS + 1000;
  recordWebhookIp('203.0.113.99', later);
  const stored = kv.get<Record<string, number[]>>('webhook_ip_hits', {});
  expect(Object.keys(stored)).toEqual(['203.0.113.99']);

  // With 70 active IPs inside the same window, the map stays capped at 64 and keeps the most recent IP.
  for (let i = 0; i < 70; i++) {
    recordWebhookIp(`192.0.2.${i}`, later + 100);
  }
  const active = kv.get<Record<string, number[]>>('webhook_ip_hits', {});
  expect(Object.keys(active).length).toBe(64);
  expect(active['192.0.2.69']).toBeDefined();
});

test('folderWatchPass waits for settle time, fires once outside quiet hours, and handles fire errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-watch-'));
  tempDirs.push(dir);
  const filePath = join(dir, 'statement.pdf');
  writeFileSync(filePath, 'pdf-bytes');
  const mtimeMs = 1_700_000_000_000;
  utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));

  settings.update({ ...ORIG_SETTINGS, timezone: 'UTC', quiet_start: '00:00', quiet_end: '00:00' });
  const state: FolderWatchState = { previous: [], lastFired: mtimeMs - 120_000 };
  const fired: string[][] = [];

  // Too fresh (< 20s settle): does not fire and keeps file unsettled for the next pass.
  const tooFresh = await folderWatchPass(state, dir, (batch) => {
    fired.push(batch.map((f) => f.name));
  }, mtimeMs + 5_000);
  expect(tooFresh).toBe(false);
  expect(fired).toEqual([]);
  expect(state.previous).toEqual([]);

  // Settled (>= 20s) and due: fires once and records trigger-downloads in DB.
  const settledOk = await folderWatchPass(state, dir, (batch) => {
    fired.push(batch.map((f) => f.name));
  }, mtimeMs + 25_000);
  expect(settledOk).toBe(true);
  expect(fired).toEqual([['statement.pdf']]);
  expect(triggers.all().find((t) => t.id === 'trigger-downloads')?.last_triggered_at).toBe(mtimeMs + 25_000);

  // A callback error is caught and logged rather than crashing the background interval.
  const file2 = join(dir, 'receipt.pdf');
  writeFileSync(file2, 'receipt');
  utimesSync(file2, new Date(mtimeMs), new Date(mtimeMs));
  const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  spies.push(warnSpy);
  const failed = await folderWatchPass(state, dir, () => {
    throw new Error('fire boom');
  }, mtimeMs + 100_000);
  expect(failed).toBe(false);
  expect(warnSpy).toHaveBeenCalled();
});

test('startFolderWatch skips when unconfigured and starts 15s poller when configured', () => {
  const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation((() => 1 as any) as any);
  spies.push(intervalSpy);

  (config as { watchDir: string }).watchDir = '';
  startFolderWatch(async () => {});
  expect(intervalSpy).not.toHaveBeenCalled();

  const dir = mkdtempSync(join(tmpdir(), 'duet-watch-start-'));
  tempDirs.push(dir);
  (config as { watchDir: string }).watchDir = dir;
  startFolderWatch(async () => {});
  expect(intervalSpy).toHaveBeenCalledTimes(1);
  expect(intervalSpy.mock.calls[0]?.[1]).toBe(15_000);
});

test('meetingPrepEnabled and checkMeetings honor lead window, quiet hours, and calendar read', async () => {
  settings.update({ ...ORIG_SETTINGS, timezone: 'UTC', quiet_start: '22:00', quiet_end: '07:00' });
  const quietNow = Date.UTC(2026, 10, 12, 23, 0, 0);
  const dayNow = Date.UTC(2026, 10, 12, 10, 0, 0);

  // Disabled when lead time is 0 or inside quiet hours.
  (config as { meetingLeadMinutes: number }).meetingLeadMinutes = 0;
  expect(meetingPrepEnabled(dayNow)).toBe(false);
  expect(await checkMeetings(() => {}, dayNow, async () => {
    throw new Error('should not read calendar when disabled');
  })).toBe(0);

  (config as { meetingLeadMinutes: number }).meetingLeadMinutes = 15;
  expect(meetingPrepEnabled(quietNow)).toBe(false);
  expect(await checkMeetings(() => {}, quietNow, async () => {
    throw new Error('should not read calendar in quiet hours');
  })).toBe(0);

  // Active outside quiet hours: fires once per upcoming event and skips far/already-announced meetings.
  expect(meetingPrepEnabled(dayNow)).toBe(true);
  const seen: string[] = [];
  const count = await checkMeetings(
    (e) => seen.push(e.title),
    dayNow,
    async () => [
      { title: 'Board Check', start: dayNow + 10 * 60_000, end: dayNow + 40 * 60_000 },
      { title: 'Too Far', start: dayNow + 90 * 60_000, end: dayNow + 120 * 60_000 },
    ],
  );
  expect(count).toBe(1);
  expect(seen).toEqual(['Board Check']);

  // Repeating immediately yields 0 because Board Check is now marked announced.
  expect(await checkMeetings((e) => seen.push(e.title), dayNow, async () => [
    { title: 'Board Check', start: dayNow + 10 * 60_000, end: dayNow + 40 * 60_000 },
  ])).toBe(0);
  expect(seen).toEqual(['Board Check']);
});
