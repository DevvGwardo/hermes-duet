import { describe, expect, test } from 'bun:test';
import type { CardData, Item, ToolStep } from '../shared/types';
import { decisionPrompt } from './prompts';
import { RESUME_OPTIONS, RETRY_OPTIONS, TIMED_OUT, failedTurnBody, lastDone, movedOn, resumeCardBody, retryTitle, runHung } from './recovery';

const step = (id: string, status: ToolStep['status'], label?: string): ToolStep => ({ id, name: `tool_${id}`, label, status, started_at: 1 });

describe('interrupted-run card', () => {
  test('names the last completed tool step, skipping the one that was cut off', () => {
    const steps = [step('a', 'done', 'search: Q3 revenue'), step('b', 'done', 'write ~/duet-work/deck.html'), step('c', 'error', 'render pdf')];
    expect(lastDone({ steps })).toBe('write ~/duet-work/deck.html');
    expect(resumeCardBody({ steps })).toContain('The last step that finished: write ~/duet-work/deck.html.');
  });

  test("a task's own ticked step beats a tool label", () => {
    const body = resumeCardBody({ steps: [step('a', 'done', 'terminal: ls')], taskSteps: [{ text: 'Pull the numbers', done: true }, { text: 'Build the slides' }] });
    expect(body).toContain('The last step that finished: Pull the numbers.');
    expect(body).not.toContain('terminal');
  });

  test('falls back to the tool name and says when nothing had finished', () => {
    expect(lastDone({ steps: [step('a', 'done')] })).toBe('tool_a');
    expect(resumeCardBody({ steps: [step('a', 'error', 'x')] })).toContain('Nothing had finished yet.');
  });

  test('mentions the silent unpause-and-retry only when it happened', () => {
    expect(resumeCardBody({ steps: [], retried: true })).toContain('retried once on my own');
    expect(resumeCardBody({ steps: [] })).not.toContain('retried');
  });
});

describe('failed chat turn card', () => {
  test('says why it stopped and how far it got', () => {
    const body = failedTurnBody({ error: 'Run failed: upstream 529 overloaded.', steps: [step('a', 'done', 'search: flights')], limitMin: 45 });
    expect(body).toStartWith('It stopped with an error: Run failed: upstream 529 overloaded. ');
    expect(body).toContain('The last step that finished: search: flights.');
    expect(failedTurnBody({ error: TIMED_OUT, steps: [], limitMin: 45 })).toStartWith('This went 45 minutes without any progress, so I stopped it. Nothing had finished yet.');
    expect(failedTurnBody({ steps: [], limitMin: 45 })).toStartWith('It stopped with an error. ');
  });

  test('a retry that fails again names the original work', () => {
    expect(retryTitle('Answered: Try “Book the 7 AM flight” again?')).toBe('Book the 7 AM flight');
    expect(retryTitle('Answered: Pick “Plan the offsite” back up?')).toBe('Plan the offsite');
    expect(retryTitle('Approved: Send the invoice')).toBe('Approved: Send the invoice');
  });

  test('a new chat message retires only the main thread’s pending resume cards', () => {
    const card = (id: string, c: Partial<CardData>): Item => ({ id, kind: 'card', created_at: 1, updated_at: 1, card: { type: 'choice', title: id, status: 'pending', resume: true, session_id: 'main', ...c } });
    const pending = [
      card('retry', {}),
      card('task', { task_id: 't1' }),
      card('other', { session_id: 'duet-task-x' }),
      card('ask', { resume: undefined }),
      card('done', { status: 'answered' }),
    ];
    expect(movedOn(pending, 'main').map((i) => i.id)).toEqual(['retry']);
  });

  test('tapping Try again hands the agent the card body', () => {
    const c = { id: 'c9', kind: 'card', created_at: 1, updated_at: 1, card: { type: 'choice', title: 'Try “x” again?', body: 'It stopped with an error.', options: [...RETRY_OPTIONS], status: 'pending', resume: true } } as Item;
    expect(decisionPrompt(c, { answer: 'Try again' })).toContain('The card said: "It stopped with an error."');
  });
});

describe('hung-run watchdog', () => {
  const limit = 45 * 60_000;
  test('a run silent for the limit is hung; one that sent an event inside it is not', () => {
    expect(runHung({ lastEventAt: 0, waitingOnUser: false }, limit, limit)).toBe(true);
    expect(runHung({ lastEventAt: 1, waitingOnUser: false }, limit, limit)).toBe(false);
  });

  test('judges silence, not total time: a long run that keeps reporting is working', () => {
    const startedAt = 0;
    const lastEventAt = startedAt + 3 * limit;
    expect(runHung({ lastEventAt, waitingOnUser: false }, lastEventAt + 60_000, limit)).toBe(false);
  });

  test('a run paused on a Hermes prompt is waiting on the user, however long', () => {
    expect(runHung({ lastEventAt: 0, waitingOnUser: true }, 10 * limit, limit)).toBe(false);
  });
});

test('every recovery card offers a way forward and a way out', () => {
  for (const options of [RESUME_OPTIONS, RETRY_OPTIONS]) {
    expect(options).toHaveLength(2);
    expect(options).toContain('Leave it');
  }
  expect(RESUME_OPTIONS[0]).toBe('Pick it up');
  expect(RETRY_OPTIONS[0]).toBe('Try again');
});
