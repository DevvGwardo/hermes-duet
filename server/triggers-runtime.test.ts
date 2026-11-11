import { afterEach, expect, test } from 'bun:test';
import { kv } from './db';
import { WEBHOOK_IP_MAX, WEBHOOK_IP_WINDOW_MS } from './triggers';
import { meetingsToPrep, newWebhookToken, recordWebhook, recordWebhookIp, webhookIpReady, webhookReady, webhookToken } from './triggers-runtime';

const ORIG_IP_HITS = kv.get<Record<string, number[]>>('webhook_ip_hits', {});
afterEach(() => {
  kv.set('webhook_ip_hits', ORIG_IP_HITS);
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
