import { expect, test } from 'bun:test';
import { createPairCode, deviceCookie, isHttps, pairBackoffMs, pairBlocked, redeemPairCode, sameOrigin } from './auth';
import { kv } from './db';

test('device cookie is HttpOnly SameSite-Lax with long Max-Age', () => {
  const c = deviceCookie('tok123', false);
  expect(c).toStartWith('duet_device=tok123;');
  expect(c).toContain('HttpOnly');
  expect(c).toContain('SameSite=Lax');
  expect(c).not.toContain('Secure');
});

test('device cookie adds Secure only on https', () => {
  expect(deviceCookie('t', true)).toContain('; Secure');
});

test('same-origin passes without origin header (non-browser clients)', () => {
  const req = new Request('http://127.0.0.1:7456/api/x', { headers: { host: '127.0.0.1:7456' } });
  expect(sameOrigin(req)).toBe(true);
});

test('same-origin matches origin host, rejects mismatches and garbage', () => {
  const ok = new Request('http://127.0.0.1:7456/api/x', {
    headers: { host: '127.0.0.1:7456', origin: 'http://127.0.0.1:7456' },
  });
  expect(sameOrigin(ok)).toBe(true);
  const evil = new Request('http://127.0.0.1:7456/api/x', {
    headers: { host: '127.0.0.1:7456', origin: 'https://evil.example' },
  });
  expect(sameOrigin(evil)).toBe(false);
  const garbage = new Request('http://127.0.0.1:7456/api/x', {
    headers: { host: '127.0.0.1:7456', origin: 'not a url' },
  });
  expect(sameOrigin(garbage)).toBe(false);
});

test('isHttps honors scheme and proxy headers', () => {
  expect(isHttps(new Request('https://x/'))).toBe(true);
  expect(isHttps(new Request('http://x/'))).toBe(false);
  expect(isHttps(new Request('http://x/', { headers: { 'x-forwarded-proto': 'https' } }))).toBe(true);
  expect(isHttps(new Request('http://x/', { headers: { 'cf-visitor': '{"scheme":"https"}' } }))).toBe(true);
});


test('the pairing brake survives a restart and backs off', async () => {
  kv.set('pair_failures', []);
  expect(pairBlocked().blocked).toBe(false);
  expect(pairBackoffMs(0)).toBe(0);
  expect(pairBackoffMs(2)).toBe(0);
  expect(pairBackoffMs(3)).toBe(30_000);
  expect(pairBackoffMs(6)).toBe(60_000);
  expect(pairBackoffMs(99)).toBe(3600_000);

  // Three wrong codes trip the first wait, and the count lives in the database rather than in module state.
  for (let i = 0; i < 3; i++) expect(await redeemPairCode('AAAA-AAAA', 'test')).toBeNull();
  expect(kv.get<number[]>('pair_failures', []).length).toBe(3);
  expect(pairBlocked().blocked).toBe(true);

  // During the wait even a real code is refused, so guessing cannot be raced against a lucky tap.
  const { code } = createPairCode();
  expect(await redeemPairCode(code, 'test')).toBeNull();

  // Eight failures in the window lock pairing until the window itself expires.
  kv.set('pair_failures', Array.from({ length: 8 }, () => Date.now()));
  const blocked = pairBlocked();
  expect(blocked.blocked).toBe(true);
  expect(blocked.waitMs).toBeGreaterThan(0);

  kv.set('pair_failures', []);
});
