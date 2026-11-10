// Pure rules for what may interrupt the user's phone, and for the per-local-day counter that backs the soft cap.
// Kept out of push.ts and db.ts so the whole matrix can be tested without web-push or a database.
import type { Settings } from '../shared/types';

export type NotifyCategory = 'approval' | 'question' | 'brief' | 'checkin' | 'task_done' | 'task_failed' | 'agent' | 'system';

export const NOTIFY_CATEGORIES: readonly NotifyCategory[] = ['approval', 'question', 'brief', 'checkin', 'task_done', 'task_failed', 'agent', 'system'];

export interface PushDecision {
  send: boolean;
  /** Why a push was held back, for the log; absent when it sends. */
  reason?: string;
}

export interface PushPrefInput {
  category: NotifyCategory;
  settings: Settings;
  /** The thread the push belongs to; muted_channels suppresses everything but approvals and questions. */
  channelId?: string;
  /** How many counted pushes already went out today, from the sent counter. */
  todayCount?: number;
}

/** The user's own consent or a direct question: these always reach the phone. */
export function isExempt(category: NotifyCategory): boolean {
  return category === 'approval' || category === 'question';
}

/**
 * Whether a push may go out. Approvals and questions are decided first and are exempt from muted channels and the
 * daily cap. Everything else follows its own switch, then the channel mute, then the cap.
 */
export function shouldPush({ category, settings, channelId, todayCount = 0 }: PushPrefInput): PushDecision {
  // Safety and consent come first: an approval or question is never muted and never spends the daily budget.
  if (isExempt(category)) return { send: true };

  const tasks = settings.notify_tasks ?? 'all';
  switch (category) {
    case 'brief':
      if (!settings.brief_enabled) return { send: false, reason: 'briefs are off' };
      break;
    case 'checkin':
      if (settings.checkins === 'off') return { send: false, reason: 'check-ins are off' };
      break;
    case 'task_done':
      if (tasks !== 'all') return { send: false, reason: tasks === 'off' ? 'task pushes are off' : 'only failed tasks push' };
      break;
    case 'task_failed':
      if (tasks === 'off') return { send: false, reason: 'task pushes are off' };
      break;
    case 'agent':
      if (settings.notify_agent === false) return { send: false, reason: 'agent notifications are off' };
      break;
    case 'system':
      break;
  }

  if (channelId && (settings.muted_channels ?? []).includes(channelId)) return { send: false, reason: 'channel is muted' };

  const cap = settings.max_pushes_per_day ?? 0;
  if (cap > 0 && todayCount >= cap) return { send: false, reason: 'daily push cap reached' };
  return { send: true };
}

/** The stored per-local-day counter: one kv value holding the date it belongs to and how many pushes it counts. */
export interface SentDay {
  date: string;
  count: number;
}

/** Fold one actually-sent push into the counter, starting a fresh day when the date has moved on. */
export function bumpSentDay(prev: SentDay | null | undefined, date: string): SentDay {
  return prev && prev.date === date ? { date: prev.date, count: prev.count + 1 } : { date, count: 1 };
}
