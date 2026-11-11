import { expect, test } from 'bun:test';
import { encodedPath, encodingHeaders, preferredEncoding } from './compress';

const req = (accept: string) => new Request('http://127.0.0.1:7456/', { headers: { 'accept-encoding': accept } });

test('brotli wins when the client accepts both', () => {
  expect(preferredEncoding(req('gzip, deflate, br'))).toBe('br');
});

test('gzip is the fallback', () => {
  expect(preferredEncoding(req('gzip, deflate'))).toBe('gzip');
});

test('q=0 is a refusal, not a preference', () => {
  expect(preferredEncoding(req('br;q=0, gzip'))).toBe('gzip');
  expect(preferredEncoding(req('br;q=0, gzip;q=0'))).toBe(null);
});

test('whitespace before semicolon parameters is ignored', () => {
  expect(preferredEncoding(req('br ; q=0.8, gzip'))).toBe('br');
  expect(preferredEncoding(req('br ; q=0, gzip;q=0.5'))).toBe('gzip');
  expect(preferredEncoding(req('br ; q=0, *;q=0.5'))).toBe('gzip');
});

test('no header means no compression', () => {
  expect(preferredEncoding(req(''))).toBe(null);
});

test('a wildcard accepts the best encoding we have', () => {
  expect(preferredEncoding(req('*'))).toBe('br');
});

test('the precompressed sibling is used only when it exists', () => {
  expect(encodedPath('/app.js', 'br', (p) => p === '/app.js.br')).toBe('/app.js.br');
  expect(encodedPath('/app.js', 'gzip', (p) => p === '/app.js.br')).toBe(null);
});

test('encoding headers always tell caches to vary', () => {
  expect(encodingHeaders(null)).toEqual({ vary: 'accept-encoding' });
  expect(encodingHeaders('br')).toEqual({ vary: 'accept-encoding', 'content-encoding': 'br' });
});
