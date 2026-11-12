// Pure rules for briefs and check-ins, kept out of runner.ts so they can be tested without a database or Hermes.
import type { BriefEntry, Item, WatchEntry } from '../shared/types';
import { parseSources, type SourceLookup } from './sources';

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

/** A brief shows at most this many decisions; the rest move to Watching so the card stays a short list. */
export const MAX_DECISIONS = 5;
const RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Normalize post_brief's decisions (ranked, capped at MAX_DECISIONS with overflow demoted to Watching) and
 * watching items, resolving `page_id` -> `file_id` and validating `sources`. Check-ins require >=1 decision;
 * morning briefs require >=1 decision or watching item.
 */
export function briefCard(
  raw: { entries?: unknown; watching?: unknown },
  opts: { morning?: boolean; pageFile?: (pageId: string) => string | null; lookup?: SourceLookup } = {},
): { entries: BriefEntry[]; watching: WatchEntry[]; demoted: string[]; unlinked: string[] } {
  const lookup = opts.lookup ?? (() => true);
  const unlinked: string[] = [];
  const fileOf = (v: unknown): string | undefined => {
    const id = text(v, 64);
    if (!id) return undefined;
    const file = opts.pageFile?.(id);
    if (!file) unlinked.push(id);
    return file || undefined;
  };
  const ranked = (Array.isArray(raw.entries) ? raw.entries : [])
    .slice(0, 10)
    .map((e: any): BriefEntry & { priority: keyof typeof RANK } => {
      const title = text(e?.title, 160);
      if (!title) throw new Error('missing entry title');
      const sources = parseSources(e?.sources, lookup);
      return {
        title,
        detail: text(e?.detail, 600) || undefined,
        priority: ['high', 'medium', 'low'].includes(e?.priority) ? e.priority : 'medium',
        action_label: text(e?.action_label, 40) || undefined,
        action_message: text(e?.action_message, 600) || undefined,
        draft: text(e?.draft, 6000) || undefined,
        file_id: fileOf(e?.page_id),
        ...(sources ? { sources } : {}),
      };
    })
    .sort((a, b) => RANK[a.priority] - RANK[b.priority]);
  const watching = (Array.isArray(raw.watching) ? raw.watching : []).slice(0, 10).flatMap((w: any): WatchEntry[] => {
    const title = text(w?.title, 160);
    if (!title) return [];
    const sources = parseSources(w?.sources, lookup);
    return [{ title, detail: text(w?.detail, 400) || undefined, file_id: fileOf(w?.page_id), ...(sources ? { sources } : {}) }];
  });
  if (!ranked.length && !opts.morning) throw new Error('post_brief needs at least one entry. If nothing needs the user, do not call post_brief.');
  if (!ranked.length && !watching.length)
    throw new Error('post_brief needs at least one entry or, for the morning brief, at least one watching item.');
  const overflow = ranked.slice(MAX_DECISIONS);
  return {
    entries: ranked.slice(0, MAX_DECISIONS),
    watching: [...overflow.map((e) => ({ title: e.title, detail: e.detail, file_id: e.file_id, ...(e.sources ? { sources: e.sources } : {}) })), ...watching].slice(0, 12),
    demoted: overflow.map((e) => e.title),
    unlinked: [...new Set(unlinked)],
  };
}

/** A tapped chip's position as the client sent it ("0", "1", …); anything else is -1, which matches no chip. */
export const chipIndex = (value: unknown) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : -1);

/** Consume a non-draft entry's stored `action_message` and mark the chip `used` so it cannot replay. */
export function useAction(card: { entries?: BriefEntry[] }, index: unknown): { entries: BriefEntry[]; message: string } {
  const i = chipIndex(index);
  const entry = card.entries?.[i];
  if (!entry || entry.draft || !entry.action_label || !entry.action_message) throw new Error('that entry has no button');
  if (entry.used) throw new Error('already sent to Hermes');
  if (entry.skipped_at) throw new Error('you skipped this one; undo the skip first');
  return { entries: card.entries!.map((e, j) => (j === i ? { ...e, used: true } : e)), message: entry.action_message };
}

/** The chip on an entry with a draft, when the agent gave it no label of its own. */
export const USE_DRAFT_LABEL = 'Send as drafted';

/** Consume an entry's stored draft, marking it `used` and building the prompt for the main session. */
export function useDraft(
  card: { entries?: BriefEntry[] },
  cardId: string,
  index: unknown,
): { entries: BriefEntry[]; shown: string; prompt: string } {
  const i = chipIndex(index);
  const entry = card.entries?.[i];
  if (!entry?.draft) throw new Error('that entry has no draft');
  if (entry.used) throw new Error('already sent to Hermes');
  if (entry.skipped_at) throw new Error('you skipped this one; undo the skip first');
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

/** Mark (or unmark) a brief decision as skipped so future check-ins and morning briefs suppress it. */
export function skipEntry(card: { entries?: BriefEntry[] }, index: unknown, undo = false, now = Date.now()): BriefEntry[] {
  const i = chipIndex(index);
  const entry = card.entries?.[i];
  if (!entry) throw new Error('that entry is not on this brief');
  if (entry.used) throw new Error('already sent to Hermes');
  if (!undo && entry.skipped_at) throw new Error('already skipped');
  if (undo && !entry.skipped_at) throw new Error('that entry is not skipped');
  return card.entries!.map((e, j) => {
    if (j !== i) return e;
    if (!undo) return { ...e, skipped_at: now };
    const { skipped_at: _, ...rest } = e;
    return rest;
  });
}

/** How far back the morning brief looks for decisions the user skipped. */
export const SKIP_MEMORY_DAYS = 7;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Rewrite the leading "<count> thing(s)/item(s)/decision(s) [need(s)]" phrase to match the capped decision count. */
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

/**
 * Why `notify` is refused in a run of this kind, or null when it may push. A check-in reaches the user only
 * through a brief with a decision (that rule is its whole judgment), and the morning brief pushes itself, so a
 * `notify` from either would be a second, unranked way to buzz the phone.
 */
export function notifyRefusal(kind: string | undefined): string | null {
  if (kind === 'checkin') return 'Not sent: a check-in reaches the user only through post_brief with at least one decision. Use that, or end with NOOP.';
  if (kind === 'brief') return 'Not sent: the morning brief notifies the user itself when you call post_brief. Put this in the brief instead.';
  return null;
}

/** How many already-raised lines of each kind a check-in prompt carries. */
const RAISED_MAX = 15;

/** Deduplicated decisions and watching items from today's briefs so check-in sessions don't repeat them. */
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
  const state = (e: BriefEntry) => (e.used ? ' (the user already acted on it)' : e.skipped_at ? ' (the user skipped it: it does not need them)' : '');
  for (const b of briefs) for (const e of b.card?.entries ?? []) add(decisions, e.title, `- [brief ${b.id}] ${e.title}${state(e)}`);
  for (const b of briefs) for (const w of b.card?.watching ?? []) add(watching, w.title, `- ${w.title}`);
  return { decisions, watching };
}

/** Decisions skipped in recent briefs (newest appearance wins per title, case-insensitive). */
export function skippedLately(briefs: Item[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [...briefs].reverse()) {
    for (const e of b.card?.entries ?? []) {
      const key = e.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.skipped_at && out.length < RAISED_MAX) out.push(`- ${e.title}`);
    }
  }
  return out;
}

/** The thread line for a morning brief that ended with no card and said nothing either. */
export const EMPTY_MORNING_NOTE = 'No brief this morning: nothing came up that needs you or is worth watching.';

/** Thread note or unposted stray text when a morning brief ends without calling post_brief. */
export function morningOutcome(run: { briefs: number; text: string }): { note: string | null; stray: string | null } {
  if (run.briefs > 0) return { note: null, stray: null };
  const t = run.text.trim();
  return t ? { note: null, stray: t } : { note: EMPTY_MORNING_NOTE, stray: null };
}

/** The two answers on the card left by a morning brief that didn't finish. */
export const BRIEF_RETRY = ['Run it now', 'Skip today'] as const;

/** Retry-card title/body when a morning brief errors before calling post_brief (null if it already posted). */
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
