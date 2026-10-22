// Pure rules for briefs and check-ins, kept out of runner.ts so they can be tested without a database or Hermes.
import type { BriefEntry } from '../shared/types';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

/**
 * Normalize post_brief entries. A brief with nothing in it isn't a brief: it would still post a card and
 * push "Heads up", so an empty list is an error the model sees, not a card the user sees.
 */
export function briefEntries(raw: unknown): BriefEntry[] {
  const entries = (Array.isArray(raw) ? raw : []).slice(0, 10).map((e: any) => {
    const title = text(e?.title, 160);
    if (!title) throw new Error('missing entry title');
    return {
      title,
      detail: text(e?.detail, 600) || undefined,
      priority: ['high', 'medium', 'low'].includes(e?.priority) ? e.priority : 'medium',
      action_label: text(e?.action_label, 40) || undefined,
      action_message: text(e?.action_message, 600) || undefined,
    } satisfies BriefEntry;
  });
  if (!entries.length) throw new Error('post_brief needs at least one entry. If nothing needs the user, do not call post_brief.');
  return entries;
}

/**
 * What a finished check-in leaves in the thread. Only a post_brief card reaches the user, and it has already
 * posted and pushed itself; the free-text reply is never posted, whatever it says. `stray` is that text when
 * nothing was surfaced and it wasn't a NOOP, so the server can log it instead of pushing it.
 */
export function checkinOutcome(run: { briefs: number; text: string }): { surfaced: boolean; stray: string | null } {
  const surfaced = run.briefs > 0;
  const t = run.text.trim();
  return { surfaced, stray: !surfaced && t && !/^\W*NOOP\b/i.test(t) ? t : null };
}
