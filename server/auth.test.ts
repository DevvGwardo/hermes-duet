import { expect, test } from 'bun:test';
import { deviceCookie, isHttps, sameOrigin } from './auth';

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
