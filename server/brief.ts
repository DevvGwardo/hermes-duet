// Pure rules for briefs and check-ins, kept out of runner.ts so they can be tested without a database or Hermes.
import type { BriefEntry, WatchEntry } from '../shared/types';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

/** A brief shows at most this many decisions; the rest move to Watching so the card stays a short list. */
export const MAX_DECISIONS = 5;
const RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Normalize post_brief's decisions and watching list. Decisions are sorted high to low (stable, so the model's
 * order holds within a priority) and capped at MAX_DECISIONS. Overflow is demoted to the front of Watching
 * instead of dropped, and `demoted` names it so the tool result can tell the model. A check-in with no decisions
 * has no reason to exist (it would still post a card and push "Heads up"), so that is an error the model sees.
 * The morning brief is the exception: on a quiet day it may post Watching alone, so the user still gets a brief
 * card instead of just a line of free text. It still needs something to show.
 */
export function briefCard(
  raw: { entries?: unknown; watching?: unknown },
  opts: { morning?: boolean } = {},
): { entries: BriefEntry[]; watching: WatchEntry[]; demoted: string[] } {
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
  const watching = (Array.isArray(raw.watching) ? raw.watching : []).slice(0, 10).flatMap((w: any): WatchEntry[] => {
    const title = text(w?.title, 160);
    return title ? [{ title, detail: text(w?.detail, 400) || undefined }] : [];
  });
  if (!ranked.length && !opts.morning) throw new Error('post_brief needs at least one entry. If nothing needs the user, do not call post_brief.');
  if (!ranked.length && !watching.length)
    throw new Error('post_brief needs at least one entry or, for the morning brief, at least one watching item.');
  const overflow = ranked.slice(MAX_DECISIONS);
  return {
    entries: ranked.slice(0, MAX_DECISIONS),
    watching: [...overflow.map((e) => ({ title: e.title, detail: e.detail })), ...watching].slice(0, 12),
    demoted: overflow.map((e) => e.title),
  };
}

/** The chip on an entry with a draft, when the agent gave it no label of its own. */
export const USE_DRAFT_LABEL = 'Send as drafted';

/**
 * Tapping an entry's draft chip. The draft comes from the stored card, never from the client, and goes back to
 * the agent verbatim so it doesn't redraft from scratch; anything outward-facing then goes through
 * request_approval, where the user sees and can edit the exact text. The entry is marked `used` so the chip
 * stays spent across reloads and devices, and a second tap is refused. `shown` is the short line the thread
 * shows as the user's message; `prompt` is what the agent receives in the main session. It names the card and
 * restates the entry because a check-in brief was written in another session the main one hasn't seen.
 */
export function useDraft(
  card: { entries?: BriefEntry[] },
  cardId: string,
  index: unknown,
): { entries: BriefEntry[]; shown: string; prompt: string } {
  const i = typeof index === 'string' && /^\d+$/.test(index) ? Number(index) : -1;
  const entry = card.entries?.[i];
  if (!entry?.draft) throw new Error('that entry has no draft');
  if (entry.used) throw new Error('already sent to Hermes');
  const label = entry.action_label || USE_DRAFT_LABEL;
  const intent = entry.action_message ? `\nWhat the button was for: ${entry.action_message}` : '';
  return {
    entries: card.entries!.map((e, j) => (j === i ? { ...e, used: true } : e)),
    shown: `${label}: ${entry.title}`,
    prompt: `[brief ${cardId}] ${label}: "${entry.title}"
The user tapped this on a brief entry${entry.detail ? ` (${entry.detail})` : ''}. Go ahead with the draft below, as drafted. Don't rewrite it.${intent}
If carrying it out is sensitive or outward-facing (sending as the user, posting, paying), call request_approval now with exactly this text as draft and the recipient and channel in summary, then stop; the user reviews and can edit it there. If something in it is no longer right, still use it and say what in one line of the summary. Otherwise just do it.

Draft:
${entry.draft}`,
  };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The model titles a brief "N things need you" before the server ranks and caps it, and it may count watched
 * items too. Rewrite the first "<number> thing(s)/item(s)/decision(s) [need(s)]" to the real decision count,
 * keeping digits vs words, capitalization and verb agreement. Titles without a count are left alone. With no
 * decisions, "<count> things need" reads "Nothing needs", so a quiet morning says so instead of "0 things".
 */
export function briefTitle(title: string, decisions: number): string {
  const re = new RegExp(`\\b(\\d+|${WORDS.join('|')})(\\s+)(thing|item|decision)s?\\b(\\s+needs?\\b)?`, 'i');
  return title.replace(re, (_m, num: string, sp: string, noun: string, verb: string | undefined, at: number) => {
    // A digit says nothing about case, so "Nothing" is capitalized only where a sentence starts.
    if (!decisions && verb) return `${/(^|[.!?]\s*)$/.test(title.slice(0, at)) ? 'N' : 'n'}othing needs`;
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

/** The thread line for a morning brief that ended with no card and said nothing either. */
export const EMPTY_MORNING_NOTE = 'No brief this morning: nothing came up that needs you or is worth watching.';

/**
 * What a finished morning brief leaves besides its card. The brief runs in the main session, so its free text
 * has already streamed into the thread as the agent's reply; with no post_brief card there was nothing to decide
 * or watch, so that reply stays a quiet line and is never pushed. `note` is a system line for a run that posted
 * no card and said nothing, so the user can still see the brief ran; `stray` is the unposted text, for the log.
 */
export function morningOutcome(run: { briefs: number; text: string }): { note: string | null; stray: string | null } {
  if (run.briefs > 0) return { note: null, stray: null };
  const t = run.text.trim();
  return t ? { note: null, stray: t } : { note: EMPTY_MORNING_NOTE, stray: null };
}
