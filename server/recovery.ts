// Pure wording and rules for the "Pick it back up?" and "Try … again?" cards, kept out of runner.ts so they can be tested without Hermes.
import type { Item, TaskStep, ToolStep } from '../shared/types';

export interface InterruptedRun {
  /** The turn already went through the silent unpause-and-retry once before this interruption. */
  retried?: boolean;
  /** Tool steps of the interrupted run (finish() has already turned any still running into errors). */
  steps: ToolStep[];
  /** A background task's own checklist, which reads better than a tool label when the agent kept it. */
  taskSteps?: TaskStep[];
}

const clip = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The last thing that finished before the interruption: the task's last ticked step, else the last completed tool call. */
export function lastDone(run: InterruptedRun): string {
  const task = [...(run.taskSteps ?? [])].reverse().find((s) => s.done && s.text.trim());
  if (task) return clip(task.text, 120);
  const tool = [...run.steps].reverse().find((s) => s.status === 'done');
  return tool ? clip(tool.label || tool.name, 120) : '';
}

export function resumeCardBody(run: InterruptedRun): string {
  const parts = ['Hermes restarted while I was working on this, so it stopped partway.'];
  if (run.retried) parts.push('This was already my second try: Hermes had paused the conversation after an earlier crash, so I unpaused it and retried once on my own.');
  const done = lastDone(run);
  parts.push(done ? `The last step that finished: ${done}${/[.!?…]$/.test(done) ? '' : '.'}` : 'Nothing had finished yet.');
  parts.push('I can continue from where the conversation left off.');
  return parts.join(' ');
}

export const TIMED_OUT = 'Timed out';
export const RESUME_OPTIONS = ['Pick it up', 'Leave it'] as const;
export const RETRY_OPTIONS = ['Try again', 'Leave it'] as const;
export const MOVED_ON = 'You carried on in chat';

/**
 * The "Try … again?" card for a chat turn that failed (a model error, or the run timeout). Without it a reply that
 * never came left only a grey note: no push, unlike a reply that did come, and nothing to tap.
 */
export function failedTurnBody(run: { error?: string; steps: ToolStep[]; limitMin: number }): string {
  const error = clip(run.error ?? '', 160).replace(/[.\s]+$/, '');
  const parts = [
    run.error === TIMED_OUT
      ? `This ran for over ${run.limitMin} minutes, so I stopped it.`
      : error
        ? `It stopped with an error: ${error}.`
        : 'It stopped with an error.',
  ];
  const done = lastDone(run);
  parts.push(done ? `The last step that finished: ${done}${/[.!?…]$/.test(done) ? '' : '.'}` : 'Nothing had finished yet.');
  parts.push("Trying again continues the same conversation, and I'll check what already went through before redoing anything.");
  return parts.join(' ');
}

/**
 * Resume cards ("Pick it back up?", "Try … again?") of the main thread that a new chat message makes moot: the
 * message continues the same conversation, failed turn included, so the card would only linger in "Needs you" and
 * re-run old work if tapped later. A background task's card stays, since chat doesn't reach that session.
 */
export function movedOn(pending: Item[], sessionId: string): Item[] {
  return pending.filter((i) => i.card?.status === 'pending' && i.card.resume && !i.card.task_id && i.card.session_id === sessionId);
}

/** What a failed turn was about, for its card title; a retry that fails again names the original work, not "Answered: Try …". */
export function retryTitle(what: string): string {
  const m = what.match(/^Answered: (?:Try “(.+)” again\?|Pick “(.+)” back up\?)$/);
  return m ? (m[1] ?? m[2]) : what;
}
