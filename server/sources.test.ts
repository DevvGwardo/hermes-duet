import { describe, expect, test } from 'bun:test';
import { isHttpUrl, parseSources, summarizeSources } from './sources';

const lookup = (known: string[] = ['i1', 't1', 'f1', 'p1']) => (kind: string, id: string) =>
  ['item', 'task', 'file', 'page'].includes(kind) ? known.includes(id) : true;

describe('structured sources', () => {
  test('missing or empty means no citations', () => {
    expect(parseSources(undefined)).toBeUndefined();
    expect(parseSources(null)).toBeUndefined();
    expect(parseSources([])).toBeUndefined();
  });

  test('valid entries validate, trim and keep their shape', () => {
    expect(
      parseSources(
        [
          { kind: 'item', id: ' i1 ', label: "  Dana's email  ", quote: ' Rent is due Friday ' },
          { kind: 'url', url: 'https://example.com/rates', label: 'Rate sheet' },
          { kind: 'connector', label: 'Calendar' },
          { kind: 'other', label: 'A phone call' },
          { kind: 'task', id: 't1', label: 'Research' },
          { kind: 'file', id: 'f1', label: 'Deck' },
        ],
        lookup(),
      ),
    ).toEqual([
      { kind: 'item', id: 'i1', label: "Dana's email", quote: 'Rent is due Friday' },
      { kind: 'url', url: 'https://example.com/rates', label: 'Rate sheet' },
      { kind: 'connector', label: 'Calendar' },
      { kind: 'other', label: 'A phone call' },
      { kind: 'task', id: 't1', label: 'Research' },
      { kind: 'file', id: 'f1', label: 'Deck' },
    ]);
  });

  test('an unknown kind is refused and names the entry', () => {
    expect(() => parseSources([{ kind: 'email', label: 'Dana' }], lookup())).toThrow(/sources\[0\].*unknown kind/);
  });

  test('a missing label is refused and names the entry', () => {
    expect(() => parseSources([{ kind: 'url', url: 'https://example.com' }], lookup())).toThrow(/sources\[0\].*label is required/);
    expect(() => parseSources([{ kind: 'connector', label: '   ' }], lookup())).toThrow(/sources\[0\].*label is required/);
    // The second entry is the bad one: the index says which source to fix.
    expect(() => parseSources([{ kind: 'other', label: 'ok' }, { kind: 'other' }], lookup())).toThrow(/sources\[1\]/);
  });

  test('a local id the lookup does not know fails instead of posting a dead chip', () => {
    expect(() => parseSources([{ kind: 'file', id: 'gone', label: 'Deck' }], lookup())).toThrow(/sources\[0\].*no file with id "gone"/);
    expect(() => parseSources([{ kind: 'item', label: 'Dana' }], lookup())).toThrow(/sources\[0\].*needs its item id/);
    expect(() => parseSources([{ kind: 'page', id: 'p1', label: 'Dashboard' }], lookup([]))).toThrow(/sources\[0\].*no page with id/);
  });

  test('only absolute http(s) URLs link out', () => {
    for (const bad of ['example.com/rates', '/rates', 'ftp://example.com/x', 'javascript:alert(1)', 'notaurl', '']) {
      expect(() => parseSources([{ kind: 'url', url: bad, label: 'Rates' }], lookup())).toThrow(/sources\[0\].*http\(s\) URL/);
    }
    expect(parseSources([{ kind: 'url', url: 'http://example.com/x', label: 'Rates' }], lookup())).toEqual([
      { kind: 'url', url: 'http://example.com/x', label: 'Rates' },
    ]);
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
  });

  test('control characters are refused, not rendered into a chip', () => {
    expect(() => parseSources([{ kind: 'other', label: 'a\x00b' }], lookup())).toThrow(/sources\[0\].*control characters/);
    expect(() => parseSources([{ kind: 'other', label: 'fine', quote: 'a\x02b' }], lookup())).toThrow(/sources\[0\].*control characters/);
    // A verbatim excerpt may span lines; a chip label may not.
    expect(parseSources([{ kind: 'other', label: 'fine', quote: 'line one\nline two' }], lookup())).toEqual([
      { kind: 'other', label: 'fine', quote: 'line one\nline two' },
    ]);
    expect(() => parseSources([{ kind: 'other', label: 'line one\nline two' }], lookup())).toThrow(/control characters/);
  });

  test('an overlong quote is refused', () => {
    expect(() => parseSources([{ kind: 'other', label: 'fine', quote: 'x'.repeat(301) }], lookup())).toThrow(/sources\[0\].*quote is too long/);
    expect(parseSources([{ kind: 'other', label: 'fine', quote: 'x'.repeat(300) }], lookup())).toEqual([
      { kind: 'other', label: 'fine', quote: 'x'.repeat(300) },
    ]);
  });

  test('an overlong label is refused', () => {
    expect(() => parseSources([{ kind: 'other', label: 'x'.repeat(121) }], lookup())).toThrow(/sources\[0\].*label is too long/);
  });

  test('more than 6 entries is refused', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ kind: 'other', label: `s${i}` }));
    expect(() => parseSources(many, lookup())).toThrow(/at most 6 entries/);
    expect(parseSources(many.slice(0, 6), lookup())).toHaveLength(6);
  });

  test('summaries read one line per citation, empty when there is nothing', () => {
    expect(summarizeSources(undefined)).toBe('');
    expect(summarizeSources([])).toBe('');
    expect(
      summarizeSources([
        { kind: 'item', id: 'i1', label: "Dana's email", quote: 'Rent is due' },
        { kind: 'url', url: 'https://example.com', label: 'Rates' },
      ]),
    ).toBe('- [item] Dana\'s email (item i1) — "Rent is due"\n- [url] Rates (https://example.com)');
  });
});
