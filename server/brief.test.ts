import { describe, expect, test } from 'bun:test';
import { briefCard, briefTitle, checkinOutcome } from './brief';

describe('check-ins stay silent unless a brief was posted', () => {
  test('free text never surfaces, NOOP or not', () => {
    for (const text of ['NOOP', 'noop.', 'NOOP — all clear', 'Nothing new.', 'All quiet since 9 AM.', '']) {
      expect(checkinOutcome({ briefs: 0, text }).surfaced).toBe(false);
    }
  });

  test('a posted brief is what surfaces', () => {
    expect(checkinOutcome({ briefs: 1, text: 'Flagged the 3 PM move.' })).toEqual({ surfaced: true, stray: null });
  });

  test('non-NOOP text with no brief is reported as stray, for the log only', () => {
    expect(checkinOutcome({ briefs: 0, text: '  Nothing new.\n' }).stray).toBe('Nothing new.');
    expect(checkinOutcome({ briefs: 0, text: 'NOOP — all clear' }).stray).toBeNull();
    expect(checkinOutcome({ briefs: 0, text: '**NOOP**' }).stray).toBeNull();
    expect(checkinOutcome({ briefs: 0, text: '' }).stray).toBeNull();
  });
});

describe('post_brief entries', () => {
  test('an empty or missing list is rejected', () => {
    expect(() => briefCard({ entries: [] })).toThrow(/at least one entry/);
    expect(() => briefCard({ watching: [{ title: 'only watching' }] })).toThrow(/at least one entry/);
  });

  test('entries are trimmed and given a default priority', () => {
    const { entries } = briefCard({ entries: [{ title: '  Reply to Dana ', priority: 'urgent', detail: '', draft: '  Hi Dana,\n\nYes. ' }] });
    expect(entries[0]).toEqual({
      title: 'Reply to Dana',
      detail: undefined,
      priority: 'medium',
      action_label: undefined,
      action_message: undefined,
      draft: 'Hi Dana,\n\nYes.',
    });
  });

  test('the morning brief may be Watching only; a check-in may not', () => {
    const quiet = { entries: [], watching: [{ title: 'Package arrives Thursday' }] };
    expect(briefCard(quiet, { morning: true })).toEqual({ entries: [], watching: [{ title: 'Package arrives Thursday', detail: undefined }], demoted: [] });
    expect(() => briefCard(quiet)).toThrow(/at least one entry/);
  });

  test('a morning brief with nothing at all is still an error', () => {
    expect(() => briefCard({ entries: [], watching: [{ title: '  ' }] }, { morning: true })).toThrow(/at least one watching item/);
  });

  test('an untitled entry is an error', () => {
    expect(() => briefCard({ entries: [{ detail: 'no title' }] })).toThrow(/missing entry title/);
  });
});

describe('brief = ranked decisions plus Watching', () => {
  test('decisions sort high to low, keeping the model order within a priority', () => {
    const { entries } = briefCard({
      entries: [
        { title: 'a', priority: 'low' },
        { title: 'b', priority: 'medium' },
        { title: 'c', priority: 'high' },
        { title: 'd' },
        { title: 'e', priority: 'high' },
      ],
    });
    expect(entries.map((e) => e.title)).toEqual(['c', 'e', 'b', 'd', 'a']);
  });

  test('more than 5 decisions: the lowest move to the front of Watching, and are named', () => {
    const out = briefCard({
      entries: [{ title: 'low', priority: 'low', draft: 'x' }, ...Array.from({ length: 6 }, (_, i) => ({ title: `h${i}`, priority: 'high' }))],
      watching: [{ title: 'Package Thursday', detail: 'UPS' }, { title: '' }],
    });
    expect(out.entries.map((e) => e.title)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4']);
    expect(out.demoted).toEqual(['h5', 'low']);
    expect(out.watching).toEqual([
      { title: 'h5', detail: undefined },
      { title: 'low', detail: undefined },
      { title: 'Package Thursday', detail: 'UPS' },
    ]);
  });

  test('the title counts decisions only', () => {
    expect(briefTitle('Good morning. 7 things need you today.', 5)).toBe('Good morning. 5 things need you today.');
    expect(briefTitle('Good morning. 2 things need you today.', 1)).toBe('Good morning. 1 thing needs you today.');
    expect(briefTitle('Heads up: Three things', 2)).toBe('Heads up: Two things');
    expect(briefTitle('Heads up: 1 item', 3)).toBe('Heads up: 3 items');
    expect(briefTitle('Good morning. Quiet day.', 2)).toBe('Good morning. Quiet day.');
  });

  test('with no decisions the count reads "Nothing needs"', () => {
    expect(briefTitle('Good morning. 2 things need you today.', 0)).toBe('Good morning. Nothing needs you today.');
    expect(briefTitle('Good morning, 0 things need you', 0)).toBe('Good morning, nothing needs you');
    expect(briefTitle('Zero items need you', 0)).toBe('Nothing needs you');
    expect(briefTitle('Good morning. Nothing needs you today.', 0)).toBe('Good morning. Nothing needs you today.');
  });
});
