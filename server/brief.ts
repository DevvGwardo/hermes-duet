// Pure rules for briefs and check-ins, kept out of runner.ts so they can be tested without a database or Hermes.
import type { BriefEntry, Item, WatchEntry } from '../shared/types';

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

/** A tapped chip's position as the client sent it ("0", "1", …); anything else is -1, which matches no chip. */
export const chipIndex = (value: unknown) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : -1);

/**
 * Tapping the chip on an entry without a draft. Its `action_message` comes from the stored card, not from the
 * client, and goes to the agent as the user's message, the same as typing it. The entry is marked `used` like a
 * draft chip, so a reload or a second device can't send the same request again.
 */
export function useAction(card: { entries?: BriefEntry[] }, index: unknown): { entries: BriefEntry[]; message: string } {
  const i = chipIndex(index);
  const entry = card.entries?.[i];
  if (!entry || entry.draft || !entry.action_label || !entry.action_message) throw new Error('that entry has no button');
  if (entry.used) throw new Error('already sent to Hermes');
  return { entries: card.entries!.map((e, j) => (j === i ? { ...e, used: true } : e)), message: entry.action_message };
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
  const i = chipIndex(index);
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

/** How many already-raised lines of each kind a check-in prompt carries. */
const RAISED_MAX = 15;

/**
 * What today's briefs already put in front of the user, as prompt lines for a check-in. Brief cards are `info`,
 * not pending, so they never reach the check-in's "already waiting" list, and the check-in runs in its own
 * session that never saw the morning brief: without this it can push "Heads up" about a decision the user read
 * at breakfast. Titles are deduplicated case-insensitively (a later check-in may restate a morning decision),
 * a title raised as a decision is not repeated under watching, and an entry whose chip was tapped says so.
 */
export function raisedToday(briefs: Item[]): { decisions: string[]; watching: string[] } {
  const seen = new Set<string>();
  const decisions: string[] = [];
  const watching: string[] = [];
  const add = (list: string[], title: string, line: string) => {
    const key = title.toLowerCase();
    if (seen.has(key) || list.length >= RAISED_MAX) return;
    seen.add(key);
    list.push(line);
  };
  for (const b of briefs) for (const e of b.card?.entries ?? []) add(decisions, e.title, `- [brief ${b.id}] ${e.title}${e.used ? ' (the user already acted on it)' : ''}`);
  for (const b of briefs) for (const w of b.card?.watching ?? []) add(watching, w.title, `- ${w.title}`);
  return { decisions, watching };
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

/** The two answers on the card left by a morning brief that didn't finish. */
export const BRIEF_RETRY = ['Run it now', 'Skip today'] as const;

/**
 * The card for a morning brief run that ended in an error before posting its brief: Hermes restarted under it, it
 * timed out, or the model call failed. The scheduler has already marked today's brief as sent, so without this the
 * user gets nothing but a generic "Something went wrong" line they never asked for, and no brief until tomorrow.
 * A run that posted its brief and failed afterwards needs nothing. `null` means leave the thread alone.
 */
export function briefFailure(run: { briefs: number; error?: string }): { title: string; body: string } | null {
  if (run.briefs > 0) return null;
  const e = (run.error ?? '').replace(/\s+/g, ' ').trim();
  const why = /^interrupted\b/i.test(e)
    ? 'Hermes restarted while I was putting it together.'
    : /^timed out\b/i.test(e)
      ? 'It ran out of time before it was done.'
      : e
        ? `Hermes reported an error: ${e.length > 160 ? `${e.slice(0, 159)}…` : e}${/[.!?…]$/.test(e) ? '' : '.'}`
        : 'Hermes stopped with an error.';
  return { title: "This morning's brief didn't finish", body: `${why} Nothing was posted. Want me to run it again now?` };
}
