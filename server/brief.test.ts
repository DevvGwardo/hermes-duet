import { describe, expect, test } from 'bun:test';
import { briefEntries, checkinOutcome } from './brief';

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
    expect(() => briefEntries([])).toThrow(/at least one entry/);
    expect(() => briefEntries(undefined)).toThrow(/at least one entry/);
  });

  test('entries are trimmed, capped and given a default priority', () => {
    const out = briefEntries([{ title: '  Reply to Dana ', priority: 'urgent', detail: '' }, ...Array(12).fill({ title: 'x' })]);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual({ title: 'Reply to Dana', detail: undefined, priority: 'medium', action_label: undefined, action_message: undefined });
  });

  test('an untitled entry is an error', () => {
    expect(() => briefEntries([{ detail: 'no title' }])).toThrow(/missing entry title/);
  });
});
