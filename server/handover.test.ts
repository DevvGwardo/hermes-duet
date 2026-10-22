import { describe, expect, test } from 'bun:test';
import type { FileEntry, Task } from '../shared/types';
import { followUps, handoverCard, useFollowUp } from './handover';

const task = (patch: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Q3 investor deck',
  status: 'done',
  steps: [],
  created_at: 1,
  updated_at: 2,
  background: true,
  ...patch,
});

const file = (id: string, task_id: string | null, created_at: number): FileEntry => ({ id, title: id, name: `${id}.html`, mime: 'text/html', size: 1, task_id, created_at });

describe('update_task follow-ups', () => {
  test('need a label and a message, trimmed, at most three', () => {
    const out = followUps([
      { label: ' Draft the email ', message: ' Draft an email to the board sharing the Q3 deck ' },
      { label: 'No message' },
      { message: 'No label' },
      ...Array(5).fill({ label: 'x', message: 'y' }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ label: 'Draft the email', message: 'Draft an email to the board sharing the Q3 deck' });
  });

  test('anything that is not a list clears them', () => {
    expect(followUps(undefined)).toEqual([]);
    expect(followUps('Draft the email')).toEqual([]);
  });
});

describe('the handover card', () => {
  test('carries the result, only this task’s files in delivery order, and its follow-ups', () => {
    const card = handoverCard(task({ result: 'Deck is ready: 12 slides.', follow_ups: [{ label: 'Send it', message: 'Email the deck to Dana' }] }), [
      file('later', 't1', 30),
      file('other', 't2', 10),
      file('first', 't1', 20),
      file('chat', null, 5),
    ]);
    expect(card).toEqual({
      type: 'handover',
      title: 'Q3 investor deck',
      body: 'Deck is ready: 12 slides.',
      file_ids: ['first', 'later'],
      follow_ups: [{ label: 'Send it', message: 'Email the deck to Dana' }],
      status: 'info',
      task_id: 't1',
    });
  });

  test('a task with no result, files or follow-ups still hands over', () => {
    const card = handoverCard(task(), []);
    expect(card.body).toBe('Finished.');
    expect(card.file_ids).toBeUndefined();
    expect(card.follow_ups).toBeUndefined();
  });

  test('a failed task hands over muted: its reason, files so far, Try again instead of follow-ups', () => {
    const card = handoverCard(
      task({ status: 'failed', result: 'Could not reach the CRM.', instructions: 'Build the deck', follow_ups: [{ label: 'Send it', message: 'Email it' }] }),
      [file('partial', 't1', 10)],
    );
    expect(card).toEqual({
      type: 'handover',
      title: 'Q3 investor deck',
      body: 'Could not reach the CRM.',
      file_ids: ['partial'],
      follow_ups: undefined,
      failed: true,
      retry: true,
      status: 'info',
      task_id: 't1',
    });
  });

  test('a failed task without stored instructions cannot be tried again', () => {
    const card = handoverCard(task({ status: 'failed' }), []);
    expect(card.body).toBe('Stopped before it finished.');
    expect(card.retry).toBeUndefined();
  });

  test('after Try again, files from the earlier attempt stay off the new card', () => {
    const card = handoverCard(task({ retried_at: 15 }), [file('old', 't1', 10), file('new', 't1', 20)]);
    expect(card.file_ids).toEqual(['new']);
    expect(card.failed).toBeUndefined();
  });

  test('refreshing the card in place keeps tapped follow-ups spent', () => {
    const t = task({ follow_ups: [{ label: 'Send it', message: 'Email the deck to Dana' }, { label: 'Shorter', message: 'Cut it to 8 slides' }] });
    const first = handoverCard(t, []);
    const tapped = { ...first, follow_ups: useFollowUp(first, '0').follow_ups };
    expect(handoverCard(t, [], tapped).follow_ups).toEqual([
      { label: 'Send it', message: 'Email the deck to Dana', used: true },
      { label: 'Shorter', message: 'Cut it to 8 slides' },
    ]);
  });
});

describe('tapping a follow-up', () => {
  const card = { follow_ups: [{ label: 'Send it', message: 'Email the deck to Dana' }, { label: 'Shorter', message: 'Cut it to 8 slides' }] };

  test('sends the stored message and marks only that follow-up used', () => {
    const out = useFollowUp(card, '1');
    expect(out.message).toBe('Cut it to 8 slides');
    expect(out.follow_ups.map((f) => !!f.used)).toEqual([false, true]);
    expect(card.follow_ups.some((f) => 'used' in f)).toBe(false);
  });

  test('a second tap or a bad index is refused', () => {
    expect(() => useFollowUp({ follow_ups: useFollowUp(card, '0').follow_ups }, '0')).toThrow(/already/);
    for (const bad of [undefined, '', '-1', '2', 'x']) expect(() => useFollowUp(card, bad)).toThrow(/no such/);
    expect(() => useFollowUp({}, '0')).toThrow(/no such/);
  });

  test('the model cannot pre-mark one as used', () => {
    expect(followUps([{ label: 'a', message: 'b', used: true }])).toEqual([{ label: 'a', message: 'b' }]);
  });
});
