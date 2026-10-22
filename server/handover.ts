// Pure rules for handing a finished background task back to the user, kept out of runner.ts so they can be
// tested without a database or Hermes.
import type { CardData, FileEntry, FollowUp, Task } from '../shared/types';
import { chipIndex } from './brief';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

/** Normalize update_task follow_ups: at most three, each needs both a label and the message it sends. */
export function followUps(raw: unknown): FollowUp[] {
  return (Array.isArray(raw) ? raw : [])
    .map((f: any) => ({ label: text(f?.label, 40), message: text(f?.message, 600) }))
    .filter((f) => f.label && f.message)
    .slice(0, 3);
}

/**
 * The one card a finished task leaves in the thread. Background task runs never stream text into the thread,
 * and their deliver_file calls post no card of their own, so this is where the result and files show up.
 * A failed or stopped task gets the same card, muted: the reason as its body, whatever it delivered before it
 * stopped, and "Try again" in place of follow-ups when its instructions were kept.
 */
export function handoverCard(task: Task, files: FileEntry[], prev?: CardData): CardData {
  const failed = task.status === 'failed';
  const own = files
    .filter((f) => f.task_id === task.id && f.created_at >= (task.retried_at ?? 0))
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, 8);
  // Refreshing a card in place rebuilds follow-ups from the task, which never stores taps; keep the ones already
  // tapped spent so the refresh doesn't re-arm them.
  const tapped = new Set(prev?.follow_ups?.filter((f) => f.used).map((f) => `${f.label}\n${f.message}`));
  return {
    type: 'handover',
    title: task.title,
    body: task.result?.trim().slice(0, 600) || (failed ? 'Stopped before it finished.' : 'Finished.'),
    file_ids: own.length ? own.map((f) => f.id) : undefined,
    follow_ups:
      !failed && task.follow_ups?.length
        ? task.follow_ups.slice(0, 3).map((f) => ({ label: f.label, message: f.message, ...(tapped.has(`${f.label}\n${f.message}`) && { used: true }) }))
        : undefined,
    failed: failed || undefined,
    retry: (failed && !!task.instructions) || undefined,
    status: 'info',
    task_id: task.id,
  };
}

/**
 * Tapping a handover follow-up. The message comes from the stored card, not from the client, and goes to the
 * main thread as the user's message; the follow-up is marked `used` so a reload or a second device can't send
 * it again.
 */
export function useFollowUp(card: { follow_ups?: FollowUp[] }, index: unknown): { follow_ups: FollowUp[]; message: string } {
  const i = chipIndex(index);
  const f = card.follow_ups?.[i];
  if (!f) throw new Error('no such follow-up');
  if (f.used) throw new Error('already sent to Hermes');
  return { follow_ups: card.follow_ups!.map((g, j) => (j === i ? { ...g, used: true } : g)), message: f.message };
}
