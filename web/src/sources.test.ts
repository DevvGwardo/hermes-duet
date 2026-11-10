import { expect, test } from 'bun:test';
import { isSafeSourceUrl } from './sources';

test('only absolute http(s) URLs become links', () => {
  expect(isSafeSourceUrl('https://example.com/rates')).toBe(true);
  expect(isSafeSourceUrl('http://example.com/x')).toBe(true);
  expect(isSafeSourceUrl(undefined)).toBe(false);
  expect(isSafeSourceUrl('')).toBe(false);
  for (const bad of ['example.com/rates', '/rates', 'ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'notaurl']) {
    expect(isSafeSourceUrl(bad)).toBe(false);
  }
});
