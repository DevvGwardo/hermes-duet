import { describe, expect, test } from 'bun:test';
import { MOBILE_VIEWPORT, normalizeInput, normalizeUrl, sameLoginSite, viewportMetrics } from './browser';

describe('normalizeUrl', () => {
  test('keeps absolute http(s) urls untouched', () => {
    expect(normalizeUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c');
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  test('adds a scheme to a bare host', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('news.ycombinator.com/item?id=1')).toBe('https://news.ycombinator.com/item?id=1');
  });

  test('refuses schemes that would read the local disk or run script', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('data:text/html,<h1>x</h1>')).toBeNull();
  });

  test('empty input is not a navigation', () => {
    expect(normalizeUrl('   ')).toBeNull();
    expect(normalizeUrl(null as unknown as string)).toBeNull();
  });
});

describe('normalizeInput', () => {
  test('passes through taps and scrolls', () => {
    expect(normalizeInput({ type: 'tap', x: 10.4, y: 20.6 })).toEqual({ type: 'tap', x: 10, y: 21 });
    expect(normalizeInput({ type: 'scroll', x: 1, y: 2, dy: 30 })).toEqual({
      type: 'scroll',
      x: 1,
      y: 2,
      dy: 30,
    });
  });

  test('clamps hostile numbers instead of forwarding them', () => {
    expect(normalizeInput({ type: 'tap', x: -5, y: NaN })).toEqual({ type: 'tap', x: 0, y: 0 });
    expect(normalizeInput({ type: 'scroll', x: 0, y: 0, dy: 1e9 })).toEqual({
      type: 'scroll',
      x: 0,
      y: 0,
      dy: 4000,
    });
  });

  test('only known keys get synthesized', () => {
    expect(normalizeInput({ type: 'key', key: 'Escape' })).toEqual({ type: 'key', key: 'Escape' });
    expect(normalizeInput({ type: 'key', key: 'F13' })).toBeNull();
    expect(normalizeInput({ type: 'key', key: 'constructor' })).toBeNull();
  });

  test('empty text and unknown types are rejected', () => {
    expect(normalizeInput({ type: 'text', text: '' })).toBeNull();
    expect(normalizeInput({ type: 'text', text: 42 })).toBeNull();
    expect(normalizeInput({ type: 'eval', code: 'x' })).toBeNull();
    expect(normalizeInput(null)).toBeNull();
    expect(normalizeInput('tap')).toBeNull();
  });

  test('text is capped so one paste cannot flood the page', () => {
    const out = normalizeInput({ type: 'text', text: 'x'.repeat(5000) });
    expect(out && out.type === 'text' ? out.text.length : 0).toBe(2000);
  });

  test('navigate goes through the url normalizer', () => {
    expect(normalizeInput({ type: 'navigate', url: 'example.com' })).toEqual({
      type: 'navigate',
      url: 'https://example.com',
    });
    expect(normalizeInput({ type: 'navigate', url: 'file:///etc/passwd' })).toBeNull();
  });

  test('tab switching needs an id', () => {
    expect(normalizeInput({ type: 'tab', id: 'ABC' })).toEqual({ type: 'tab', id: 'ABC' });
    expect(normalizeInput({ type: 'tab', id: '' })).toBeNull();
  });
});

describe('viewportMetrics', () => {
  test('mobile is an iPhone layout with touch', () => {
    expect(viewportMetrics('mobile')).toEqual({ ...MOBILE_VIEWPORT, mobile: true });
    expect(MOBILE_VIEWPORT).toEqual({ width: 390, height: 844, deviceScaleFactor: 3 });
  });

  test('desktop clears the override rather than guessing a size', () => {
    expect(viewportMetrics('desktop')).toBeNull();
  });
});

describe('sameLoginSite', () => {
  test('the saved site and its subdomains are the same site', () => {
    expect(sameLoginSite('example.com', 'example.com')).toBe(true);
    expect(sameLoginSite('example.com', 'www.example.com')).toBe(true);
    expect(sameLoginSite('example.com', 'app.example.com')).toBe(true);
    expect(sameLoginSite('www.example.com', 'example.com')).toBe(true);
    expect(sameLoginSite('Example.COM', 'app.example.com.')).toBe(true);
  });

  test('a credential saved for a subdomain is not typed into the bare domain', () => {
    expect(sameLoginSite('app.example.com', 'example.com')).toBe(false);
  });

  test('lookalike hosts are not the same site', () => {
    expect(sameLoginSite('example.com', 'example.com.evil.test')).toBe(false);
    expect(sameLoginSite('example.com', 'evil-example.com')).toBe(false);
    expect(sameLoginSite('example.com', 'example.org')).toBe(false);
    expect(sameLoginSite('bank.com', 'bank.com.co')).toBe(false);
  });

  test('an unknown host on either side never matches', () => {
    expect(sameLoginSite('', 'example.com')).toBe(false);
    expect(sameLoginSite('example.com', '')).toBe(false);
  });
});
