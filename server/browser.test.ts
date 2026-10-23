import { describe, expect, test } from 'bun:test';
import { normalizeInput, normalizeUrl } from './browser';

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