import { expect, test } from 'bun:test';
import { meetingsToPrep, newWebhookToken, recordWebhook, webhookReady, webhookToken } from './triggers-runtime';

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
