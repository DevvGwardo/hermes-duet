import { describe, expect, test } from 'bun:test';
import type { Page } from '../shared/types';
import { pageInput, pagesDue, refreshTime } from './pages';

const page = (id: string, fields: Partial<Page> = {}): Page => ({
  id,
  title: `Page ${id}`,
  instructions: 'Rebuild it.',
  file_id: `f-${id}`,
  created_at: 0,
  updated_at: 0,
  ...fields,
});
const idle = () => false;
const at = (hhmm: string, date = '2026-10-22') => {
  const [h, m] = hhmm.split(':').map(Number);
  return { date, minutes: h * 60 + m };
};

describe('standing page refresh slot', () => {
  test('runs 30 minutes before the brief, clamped at midnight', () => {
    expect(refreshTime('07:30')).toBe('07:00');
    expect(refreshTime('08:10')).toBe('07:40');
    expect(refreshTime('00:15')).toBe('00:00');
  });

  test('due from the refresh time until midday, once per day', () => {
    const pages = [page('a'), page('b', { refreshed_on: '2026-10-22' }), page('c', { refreshed_on: '2026-10-21' })];
    expect(pagesDue(pages, at('06:59'), '07:30', idle)).toEqual([]);
    expect(pagesDue(pages, at('07:00'), '07:30', idle).map((p) => p.id)).toEqual(['a', 'c']);
    expect(pagesDue(pages, at('11:59'), '07:30', idle).map((p) => p.id)).toEqual(['a', 'c']);
    expect(pagesDue(pages, at('12:00'), '07:30', idle)).toEqual([]);
  });

  test('a late brief still gets its refresh slot', () => {
    expect(pagesDue([page('a')], at('13:30'), '14:00', idle).map((p) => p.id)).toEqual(['a']);
  });

  test('a page whose last refresh is still running is skipped', () => {
    const pages = [page('a', { task_id: 't1' }), page('b')];
    expect(pagesDue(pages, at('07:05'), '07:30', (p) => p.task_id === 't1').map((p) => p.id)).toEqual(['b']);
  });
});

describe('save_page input', () => {
  test('a new page needs a file, a title and rebuild instructions', () => {
    expect(() => pageInput({ title: 'Morning', instructions: 'x' })).toThrow(/file_id/);
    expect(() => pageInput({ file_id: 'f1', instructions: 'x' })).toThrow(/title/);
    expect(() => pageInput({ file_id: 'f1', title: 'Morning', instructions: '   ' })).toThrow(/instructions/);
    expect(pageInput({ file_id: ' f1 ', title: ' Morning ', instructions: ' Read the calendar. ' })).toEqual({
      file_id: 'f1',
      title: 'Morning',
      instructions: 'Read the calendar.',
    });
  });

  test('an update keeps what it does not pass', () => {
    const existing = page('a', { title: 'Old', instructions: 'Old way.', file_id: 'f-old' });
    expect(pageInput({ instructions: 'New way.' }, existing)).toEqual({ title: 'Old', instructions: 'New way.', file_id: 'f-old' });
  });
});
