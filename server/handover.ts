// Pure rules for handing a finished background task back to the user, kept out of runner.ts so they can be
// tested without a database or Hermes.
import type { CardData, FileEntry, FollowUp, Task } from '../shared/types';

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
 */
export function handoverCard(task: Task, files: FileEntry[]): CardData {
  const own = files
    .filter((f) => f.task_id === task.id)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(0, 8);
  return {
    type: 'handover',
    title: task.title,
    body: task.result?.trim().slice(0, 600) || 'Finished.',
    file_ids: own.length ? own.map((f) => f.id) : undefined,
    follow_ups: task.follow_ups?.length ? task.follow_ups.slice(0, 3) : undefined,
    status: 'info',
    task_id: task.id,
  };
}
