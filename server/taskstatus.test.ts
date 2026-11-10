import { expect, test } from 'bun:test';
import type { Task } from '../shared/types';
import { confirmationLabel, confirmationState, withAgentDone, withConfirmed, withReopened } from './taskstatus';

const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'hc',
  status: 'running',
  steps: [],
  created_at: 1_000,
  updated_at: 1_000,
  background: true,
  ...over,
});

test('confirmation follows the user, not the agent', () => {
  expect(confirmationState(task())).toBe('open');
  expect(confirmationState(task({ status: 'done' }))).toBe('needs-confirm');
  expect(confirmationState(task({ status: 'done', confirmed_at: 5 }))).toBe('confirmed');
  // Even a failed or cancelled task counts as confirmed once the user said so.
  expect(confirmationState(task({ status: 'failed', confirmed_at: 5 }))).toBe('confirmed');
});

test('confirmation labels say what the user must do', () => {
  expect(confirmationLabel(task())).toBe('Open');
  expect(confirmationLabel(task({ status: 'done' }))).toBe('Looks done — confirm');
  expect(confirmationLabel(task({ status: 'done', confirmed_at: 5 }))).toBe('Confirmed by you');
});

test('agent_done_at is stamped once, only for done', () => {
  expect(withAgentDone(task()).agent_done_at).toBeUndefined();
  const first = withAgentDone(task({ status: 'done' }), 7);
  expect(first.agent_done_at).toBe(7);
  // A later update keeps the first finish instead of moving the stamp.
  expect(withAgentDone({ ...first }, 9).agent_done_at).toBe(7);
});

test('confirm and reopen are inverses, and reopen keeps the agent stamp', () => {
  const done = withAgentDone(task({ status: 'done' }), 7);
  const confirmed = withConfirmed(done, 8);
  expect(confirmed.confirmed_at).toBe(8);
  expect(confirmed.updated_at).toBe(8);
  // Confirming twice keeps the first tap.
  expect(withConfirmed(confirmed, 9).confirmed_at).toBe(8);
  const reopened = withReopened(confirmed);
  expect(reopened.confirmed_at).toBeUndefined();
  expect(reopened.agent_done_at).toBe(7);
  // Reopening an unconfirmed task changes nothing.
  expect(withReopened(done)).toEqual(done);
});
