// Pure wording for the "Pick it back up?" card, kept out of runner.ts so it can be tested without Hermes.
import type { TaskStep, ToolStep } from '../shared/types';

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
