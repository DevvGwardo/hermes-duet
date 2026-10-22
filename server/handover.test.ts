import { describe, expect, test } from 'bun:test';
import type { FileEntry, Task } from '../shared/types';
import { followUps, handoverCard } from './handover';

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
});
