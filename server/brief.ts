// Pure rules for briefs and check-ins, kept out of runner.ts so they can be tested without a database or Hermes.
import type { BriefEntry, WatchEntry } from '../shared/types';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

/** A brief shows at most this many decisions; the rest move to Watching so the card stays a short list. */
export const MAX_DECISIONS = 5;
const RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Normalize post_brief's decisions and watching list. Decisions are sorted high to low (stable, so the model's
 * order holds within a priority) and capped at MAX_DECISIONS. Overflow is demoted to the front of Watching
 * instead of dropped, and `demoted` names it so the tool result can tell the model. A brief with no decisions
 * isn't a brief: it would still post a card and push "Heads up", so that is an error the model sees.
 */
export function briefCard(raw: { entries?: unknown; watching?: unknown }): { entries: BriefEntry[]; watching: WatchEntry[]; demoted: string[] } {
  const ranked = (Array.isArray(raw.entries) ? raw.entries : [])
    .slice(0, 10)
    .map((e: any): BriefEntry & { priority: keyof typeof RANK } => {
      const title = text(e?.title, 160);
      if (!title) throw new Error('missing entry title');
      return {
        title,
        detail: text(e?.detail, 600) || undefined,
        priority: ['high', 'medium', 'low'].includes(e?.priority) ? e.priority : 'medium',
        action_label: text(e?.action_label, 40) || undefined,
        action_message: text(e?.action_message, 600) || undefined,
        draft: text(e?.draft, 6000) || undefined,
      };
    })
    .sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  if (!ranked.length) throw new Error('post_brief needs at least one entry. If nothing needs the user, do not call post_brief.');
  const overflow = ranked.slice(MAX_DECISIONS);
  const watching = (Array.isArray(raw.watching) ? raw.watching : []).slice(0, 10).flatMap((w: any): WatchEntry[] => {
    const title = text(w?.title, 160);
    return title ? [{ title, detail: text(w?.detail, 400) || undefined }] : [];
  });
  return {
    entries: ranked.slice(0, MAX_DECISIONS),
    watching: [...overflow.map((e) => ({ title: e.title, detail: e.detail })), ...watching].slice(0, 12),
    demoted: overflow.map((e) => e.title),
  };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The model titles a brief "N things need you" before the server ranks and caps it, and it may count watched
 * items too. Rewrite the first "<number> thing(s)/item(s)/decision(s) [need(s)]" to the real decision count,
 * keeping digits vs words, capitalization and verb agreement. Titles without a count are left alone.
 */
export function briefTitle(title: string, decisions: number): string {
  const re = new RegExp(`\\b(\\d+|${WORDS.join('|')})(\\s+)(thing|item|decision)s?\\b(\\s+needs?\\b)?`, 'i');
  return title.replace(re, (_m, num: string, sp: string, noun: string, verb?: string) => {
    let n = /\d/.test(num) ? String(decisions) : (WORDS[decisions] ?? String(decisions));
    if (num[0] !== num[0].toLowerCase()) n = n[0].toUpperCase() + n.slice(1);
    const one = decisions === 1;
    return `${n}${sp}${noun}${one ? '' : 's'}${verb ? verb.replace(/needs?/i, one ? 'needs' : 'need') : ''}`;
  });
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
