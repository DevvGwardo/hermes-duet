// Pure task-completion rules, kept out of runner.ts so they can be tested
// without a database or Hermes. runner.ts applies them around its writes;
// the client mirrors only the two label strings.
import type { Task } from '../shared/types';

/** Where a task stands from the user's point of view. */
export type TaskConfirmation = 'confirmed' | 'needs-confirm' | 'open';

/**
 * A task the user tapped Done on is finished, full stop. One the agent
 * marked done but the user hasn't confirmed only "looks done". Anything
 * else is still open, whatever the agent said.
 */
export function confirmationState(task: Pick<Task, 'status' | 'confirmed_at'>): TaskConfirmation {
  if (task.confirmed_at) return 'confirmed';
  if (task.status === 'done') return 'needs-confirm';
  return 'open';
}

/** The one line the Tasks tab and the handover card show about completion. */
export function confirmationLabel(task: Pick<Task, 'status' | 'confirmed_at'>): string {
  switch (confirmationState(task)) {
    case 'confirmed':
      return 'Confirmed by you';
    case 'needs-confirm':
      return 'Looks done — confirm';
    default:
      return 'Open';
  }
}

/**
 * Stamp when the agent reported the task finished. Set once: a later
 * update_task must not move it, so the first finish is what the user sees.
 * Only applies when the task reads done; anything else passes through.
 */
export function withAgentDone(task: Task, now = Date.now()): Task {
  if (task.status !== 'done' || task.agent_done_at) return task;
  return { ...task, agent_done_at: now };
}

/** The user's own completion. The real one; never set by the agent. */
export function withConfirmed(task: Task, now = Date.now()): Task {
  if (task.confirmed_at) return task;
  return { ...task, confirmed_at: now, updated_at: now };
}

/** Clear the user's completion; the agent's `agent_done_at` stays as history. */
export function withReopened(task: Task): Task {
  if (task.confirmed_at === undefined) return task;
  const { confirmed_at: _drop, ...rest } = task;
  return { ...rest };
}
