import { expect, test } from 'bun:test';
import type { Item, Settings, Task } from '../shared/types';
import { briefPrompt, checkinPrompt, pageRefreshInstructions, persona, taskPrompt } from './prompts';

const settings = (extra: Partial<Settings> = {}): Settings => ({
  brief_enabled: true,
  brief_time: '07:30',
  checkins: 'off',
  quiet_start: '22:00',
  quiet_end: '07:00',
  timezone: 'America/Chicago',
  ...extra,
});

const task = (extra: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Build the deck',
  status: 'running',
  steps: [],
  created_at: 0,
  updated_at: 0,
  background: true,
  ...extra,
});

test('persona names the assistant, timezone and background task wiring', () => {
  const p = persona(settings(), { taskId: 't9' });
  expect(p).toContain('Hermes');
  expect(p).toContain('America/Chicago');
  expect(p).toContain('task t9');
  expect(p).toContain('task_id="t9"');
  expect(persona(settings())).not.toContain('task_id=');
});

test('brief prompt with empty state still instructs one post_brief call', () => {
  const p = briefPrompt(settings(), { pending: [], tasks: [], pages: [], skipped: [] });
  expect(p).toContain('post_brief once');
  expect(p).toContain('None.');
});

test('brief prompt surfaces pending cards, tasks, pages and skipped decisions', () => {
  const pending: Item[] = [
    { id: 'c1', kind: 'card', created_at: 0, updated_at: 0, card: { type: 'approval', title: 'Send it', status: 'pending' } },
  ];
  const p = briefPrompt(settings(), {
    pending,
    tasks: [task({ result: 'half done' })],
    pages: ['Rent moved to Friday'],
    skipped: ['Gym reminder'],
  });
  expect(p).toContain('[approval c1] Send it');
  expect(p).toContain('[task t1] Build the deck: running. half done');
  expect(p).toContain('Rent moved to Friday');
  expect(p).toContain('Gym reminder');
});

test('check-in prompt scopes to new items and names what is already waiting', () => {
  const pending: Item[] = [
    { id: 'q1', kind: 'card', created_at: 0, updated_at: 0, card: { type: 'choice', title: 'Which?', status: 'pending' } },
  ];
  const p = checkinPrompt(settings(), {
    since: '2:00 PM',
    pending,
    tasks: [],
    raised: { decisions: ['Picked venue'], watching: ['Rent due'] },
  });
  expect(p).toContain('since 2:00 PM');
  expect(p).toContain('NOOP');
  expect(p).toContain('[choice q1] Which?');
  expect(p).toContain('Picked venue');
  expect(p).toContain('Rent due');
});

test('task prompt distinguishes fresh starts from retries and auto-restarts', () => {
  const fresh = taskPrompt(task(), 'Do the thing');
  expect(fresh).toContain('[task t1] Build the deck');
  expect(fresh).toContain('Do the thing');
  expect(fresh).not.toContain('Try again');
  expect(taskPrompt(task(), 'Do it', 'network blew up')).toContain('Try again');
  expect(taskPrompt(task(), 'Do it', 'hermes died', true)).toContain('Start from scratch');
});

test('page refresh instructions keep layout unless told otherwise', () => {
  const page = { id: 'p1', title: 'Rent tracker', instructions: 'Sum the ledger.', file_id: 'f1' } as any;
  expect(pageRefreshInstructions(page, '/tmp/rent.html')).toContain('keep its layout');
  expect(pageRefreshInstructions(page, null)).toContain('build it fresh');
  expect(pageRefreshInstructions(page, '/tmp/rent.html')).toContain('Sum the ledger.');
});
