import { describe, expect, test } from 'bun:test';
import type { BriefEntry, Item } from '../shared/types';
import { EMPTY_MORNING_NOTE, USE_DRAFT_LABEL, briefCard, briefTitle, checkinOutcome, morningOutcome, raisedToday, useAction, useDraft } from './brief';

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

describe('a morning brief with no card never pushes its free text', () => {
  test('a posted brief leaves nothing else to do', () => {
    expect(morningOutcome({ briefs: 1, text: 'Brief is up.' })).toEqual({ note: null, stray: null });
  });

  test('a reply with no card stays the quiet line already in the thread, logged only', () => {
    expect(morningOutcome({ briefs: 0, text: '  Nothing on your plate today.\n' })).toEqual({ note: null, stray: 'Nothing on your plate today.' });
  });

  test('no card and no reply leaves a system line so the brief is seen to have run', () => {
    for (const text of ['', '  \n']) expect(morningOutcome({ briefs: 0, text })).toEqual({ note: EMPTY_MORNING_NOTE, stray: null });
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

describe('a brief entry hands its draft back in one tap', () => {
  const card: { entries: BriefEntry[] } = {
    entries: [
      { title: 'Reply to Dana about the lease', detail: 'Renewal due Friday', draft: 'Hi Dana,\n\nYes, we will renew.', action_label: 'Send it', action_message: 'Reply to Dana' },
      { title: 'Book the dentist', action_label: 'Find a slot', action_message: 'Find me a dentist slot' },
      { title: 'Pay the plumber', draft: '$180 via Venmo to @joe' },
    ],
  };

  test('the stored draft goes to the agent verbatim, aimed at request_approval', () => {
    const out = useDraft(card, 'c1', '0');
    expect(out.shown).toBe('Send it: Reply to Dana about the lease');
    expect(out.prompt.startsWith('[brief c1] Send it: "Reply to Dana about the lease"')).toBe(true);
    expect(out.prompt).toContain('(Renewal due Friday)');
    expect(out.prompt).toContain('request_approval');
    expect(out.prompt).toContain('What the button was for: Reply to Dana');
    expect(out.prompt.endsWith('Draft:\nHi Dana,\n\nYes, we will renew.')).toBe(true);
  });

  test('only the tapped entry is marked used, and the card is not mutated', () => {
    const out = useDraft(card, 'c1', '2');
    expect(out.entries.map((e) => !!e.used)).toEqual([false, false, true]);
    expect(out.shown).toBe(`${USE_DRAFT_LABEL}: Pay the plumber`);
    expect(out.prompt).not.toContain('What the button was for');
    expect(card.entries.some((e) => e.used)).toBe(false);
  });

  test('a second tap, an entry without a draft, or a bad index is refused', () => {
    expect(() => useDraft({ entries: useDraft(card, 'c1', '0').entries }, 'c1', '0')).toThrow(/already/);
    expect(() => useDraft(card, 'c1', '1')).toThrow(/no draft/);
    for (const bad of [undefined, '', '-1', '9', '0x0', '1.5']) expect(() => useDraft(card, 'c1', bad)).toThrow(/no draft/);
  });

  test('the model cannot pre-mark an entry as used', () => {
    expect(briefCard({ entries: [{ title: 'x', draft: 'y', used: true }] }).entries[0].used).toBeUndefined();
  });
});

describe('a brief entry without a draft sends its message in one tap', () => {
  const card: { entries: BriefEntry[] } = {
    entries: [
      { title: 'Reply to Dana', draft: 'Hi Dana', action_label: 'Send it', action_message: 'Reply to Dana' },
      { title: 'Book the dentist', action_label: 'Find a slot', action_message: 'Find me a dentist slot' },
      { title: 'Rent went up', detail: 'Just so you know' },
    ],
  };

  test('the stored message is what gets sent, and only that entry is marked used', () => {
    const out = useAction(card, '1');
    expect(out.message).toBe('Find me a dentist slot');
    expect(out.entries.map((e) => !!e.used)).toEqual([false, true, false]);
    expect(card.entries.some((e) => e.used)).toBe(false);
  });

  test('a second tap, an entry with a draft or no button, or a bad index is refused', () => {
    expect(() => useAction({ entries: useAction(card, '1').entries }, '1')).toThrow(/already/);
    expect(() => useAction(card, '0')).toThrow(/no button/);
    expect(() => useAction(card, '2')).toThrow(/no button/);
    for (const bad of [undefined, '', '-1', '9', '1.0']) expect(() => useAction(card, bad)).toThrow(/no button/);
  });
});

describe('check-ins see what today\'s briefs already raised', () => {
  const brief = (id: string, entries: BriefEntry[], watching: { title: string }[] = []): Item =>
    ({ id, kind: 'card', created_at: 0, updated_at: 0, card: { type: 'brief', title: 'Brief', status: 'info', entries, watching } }) as Item;

  test('decisions carry their card id and whether the user already acted', () => {
    const r = raisedToday([brief('b1', [{ title: 'Reply to Dana' }, { title: 'Pay rent', used: true }], [{ title: 'Package Thursday' }])]);
    expect(r.decisions).toEqual(['- [brief b1] Reply to Dana', '- [brief b1] Pay rent (the user already acted on it)']);
    expect(r.watching).toEqual(['- Package Thursday']);
  });

  test('a restated title is listed once, and a decision is not repeated under watching', () => {
    const r = raisedToday([
      brief('b1', [{ title: 'Reply to Dana' }], [{ title: 'Rent due Friday' }]),
      brief('b2', [{ title: 'reply to dana' }, { title: 'Rent due Friday' }]),
    ]);
    expect(r.decisions).toEqual(['- [brief b1] Reply to Dana', '- [brief b2] Rent due Friday']);
    expect(r.watching).toEqual([]);
  });

  test('no briefs today means nothing raised', () => {
    expect(raisedToday([])).toEqual({ decisions: [], watching: [] });
  });
});
