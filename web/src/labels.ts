import type { Task } from '../../shared/types';

/** Shared by the Tasks tab and the in-thread task chip, so the lazy tab and the thread do not import each other. */
export const STATUS_LABEL: Record<Task['status'], string> = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
