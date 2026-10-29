import { describe, expect, test } from 'bun:test';
import { parseEnvValue } from './config';

// .env values used to keep their inline comment, so `DUET_PORT=7456  # the app` became "7456  # the app" and every
// Number() over it was NaN — which silently stopped the hung-run watchdog (elapsed >= NaN is never true).
describe('parseEnvValue', () => {
  test('drops an inline comment after whitespace', () => {
    expect(parseEnvValue('7456 # the app port')).toBe('7456');
    expect(parseEnvValue('http://127.0.0.1:8642   # gateway')).toBe('http://127.0.0.1:8642');
  });

  test('keeps a # inside quotes', () => {
    expect(parseEnvValue('"https://host/path#frag"')).toBe('https://host/path#frag');
    expect(parseEnvValue("'a#b'")).toBe('a#b');
  });

  test('a value that is only a comment is empty', () => {
    expect(parseEnvValue('# defaults to API_SERVER_KEY')).toBe('');
  });

  test('strips surrounding quotes and whitespace', () => {
    expect(parseEnvValue('  "spaced value"  ')).toBe('spaced value');
    expect(parseEnvValue("'quoted'")).toBe('quoted');
    expect(parseEnvValue('  plain  ')).toBe('plain');
  });

  test('keeps # that is not preceded by whitespace', () => {
    expect(parseEnvValue('https://x.ts.net:8443/#/r')).toBe('https://x.ts.net:8443/#/r');
  });

  test('empty stays empty', () => {
    expect(parseEnvValue('')).toBe('');
    expect(parseEnvValue('""')).toBe('');
  });
});
