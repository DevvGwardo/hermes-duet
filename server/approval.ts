// Pure rules for deciding an approval card, kept out of runner.ts so they can be tested without a database or
// Hermes. A Duet approval may carry `draft`: the exact text the agent will send. The user can edit it on the
// card before approving; the edited text replaces the draft on the card and goes back to the agent verbatim.
import type { CardData, Item } from '../shared/types';
import type { PushPayload } from './push';

export const DRAFT_MAX = 8000;

export interface ApprovalDecision {
  approved: boolean;
  /** Set when user opted "Approve & don't ask again" on an eligible card. */
  remember?: boolean;
  /** Set only when the user changed the draft: the text the agent must send instead of its own. */
  draft?: string;
}

/** Resolve a tap on an approval card. `value` is the draft as the user left it (absent from push actions). */
export function approvalDecision(card: CardData, action: string, value: unknown): ApprovalDecision {
  if (action !== 'approve' && action !== 'approve_always' && action !== 'decline') throw new Error('invalid action');
  if (action === 'decline') return { approved: false };
  const remember = action === 'approve_always';
  // Hermes-native approvals have no draft to edit; their decision is a plain once/deny.
  if (!card.draft || card.hermes || typeof value !== 'string') return { approved: true, ...(remember && { remember: true }) };
  const text = value.trim();
  if (text === card.draft.trim()) return { approved: true, ...(remember && { remember: true }) };
  if (!text) throw new Error('the draft is empty');
  if (text.length > DRAFT_MAX) throw new Error('the draft is too long');
  return { approved: true, ...(remember && { remember: true }), draft: text };
}

/**
 * Build the push payload for an approval card. Cards with a Duet draft or Hermes command set `must_read`
 * so the service worker requires opening the card rather than allowing a one-tap unseen approval; neither
 * draft nor command text is placed in the payload.
 */
export function approvalPush(card: Item): PushPayload {
  const c = card.card!;
  const hermesCommand = c.hermes?.kind === 'approval';
  const mustRead = hermesCommand || Boolean(c.draft);
  const hint = hermesCommand ? 'Check the command first.' : 'Draft ready to read.';
  return {
    title: 'Needs your OK',
    body: mustRead ? `${c.title}. ${hint}` : c.title,
    card_id: card.id,
    approval: true,
    must_read: mustRead || undefined,
    action_label: c.action_label,
    tag: card.id,
    url: `/?card=${card.id}`,
    category: 'approval',
  };
}

/** Above this many open asks the id list is left off a push (web push payloads top out around 4 KB). */
export const OPEN_ASKS_MAX = 30;

/**
 * Piggyback `ask`/`open` metadata on outgoing pushes so the service worker can dismiss settled lock-screen
 * banners without sending silent pushes (which iOS disallows). Omits `open` if above OPEN_ASKS_MAX.
 */
export function askMarks(p: Pick<PushPayload, 'card_id'>, pending: Item[], now: number): Pick<PushPayload, 'ask' | 'open' | 'sent_at'> {
  const open = pending
    .filter((i) => i.card?.status === 'pending' && (i.card.type === 'approval' || i.card.type === 'choice' || i.card.type === 'payment'))
    .map((i) => i.id);
  return {
    ...(p.card_id && open.includes(p.card_id) && { ask: true }),
    ...(open.length <= OPEN_ASKS_MAX && { open }),
    sent_at: now,
  };
}

export const PROMPT_ENDED = 'Its run ended';

/** Hermes-native prompts whose owning run is no longer live (their answer can no longer be delivered). */
export function deadPrompts(pending: Item[], live: ReadonlySet<string>): Item[] {
  return pending.filter((i) => i.card?.status === 'pending' && i.card.hermes && !live.has(i.card.hermes.run_id));
}

export const REPLACED = 'Replaced by a newer version';

/**
 * Return a refusal reason if `target` cannot be replaced by `replaces`, or null if valid.
 * Scoped to pending Duet-native cards of the same kind in the calling session.
 */
export function replaceRefusal(target: Item | null | undefined, type: 'approval' | 'choice', sessionId: string): string | null {
  const c = target?.kind === 'card' ? target.card : undefined;
  if (!c) return 'there is no such card';
  if (c.type !== type || c.hermes || c.resume || c.rerun) return `it is not one of your ${type === 'approval' ? 'request_approval' : 'ask'} cards`;
  if (c.session_id !== sessionId) return 'it belongs to another conversation';
  if (c.status === 'expired') return 'it already expired';
  if (c.status !== 'pending') return `the user already ${c.status} it`;
  return null;
}

export const WITHDRAWN = 'Withdrawn';

/** Return a refusal reason if `withdraw_card` cannot withdraw `target` from `sessionId`, or null if allowed. */
export function withdrawRefusal(target: Item | null | undefined, sessionId: string): string | null {
  const type = target?.card?.type;
  if (type !== 'approval' && type !== 'choice') return target?.card ? 'it is not an approval or question card' : 'there is no such card';
  return replaceRefusal(target, type, sessionId);
}

/** Above this many, the turn's note lists only the newest waiting cards. */
const WAITING_NOTE_MAX = 5;

/** Prefix for chat turns listing pending asks so text replies can withdraw settled cards (approvals still require tapping Approve). */
export function waitingNote(pending: Item[], sessionId: string): string {
  const mine = pending.filter((i) => !withdrawRefusal(i, sessionId)).sort((a, b) => b.created_at - a.created_at);
  if (!mine.length) return '';
  const lines = mine.slice(0, WAITING_NOTE_MAX).map((i) => `- [${i.card!.type === 'approval' ? 'approval' : 'question'} ${i.id}] ${i.card!.title}`);
  return `(Cards of yours still waiting on the user's tap:\n${lines.join('\n')}\nIf this message declines one, answers one, or makes one moot, call withdraw_card with its id before going on, so it can't be tapped later. If it asks for changes to an approval, redraft with replaces instead. If it says yes to an approval, don't act on that: ask them to tap the card's button, which has the exact draft.)\n\n`;
}

/** Waiting-cards note for chat turns and steers (omitted for briefs, check-ins, and tasks). */
export function turnNote(pending: Item[], run: { kind: string; sessionId: string }): string {
  return run.kind === 'chat' ? waitingNote(pending, run.sessionId) : '';
}

/** Staleness check appended when an approval or answer arrives long after the card was posted (`age` from askAge). */
export function oldAskNote(age: string | null | undefined, kind: 'approval' | 'edited' | 'answer'): string {
  if (!age) return '';
  if (kind === 'answer') {
    return ` This question was asked ${age}, not just now. If what has happened since makes the answer no longer fit, say so in one line before going on.`;
  }
  const dated = kind === 'approval' ? ' anything relative in it ("today", "tomorrow", "tonight") now points to a different day, a date or time in it has passed, or' : '';
  return ` This card was posted ${age}, not just now. Before acting, check it still holds: don't go ahead if${dated} it was already done or overtaken since. In that case tell the user in one line what changed, and post a fresh request_approval if it should still happen.`;
}

/** The message that resumes the agent's session after an approval decision. `age` is set when the card is old (askAge). */
export function approvalPrompt(card: Item, approved: boolean, age?: string | null): string {
  const c = card.card!;
  const tapped = c.action_label || 'Approve';
  if (!approved) {
    return `[approval ${card.id}] NOT NOW: "${c.title}". The user declined for now. Don't do it. Acknowledge in one short line, and offer an alternative only if there's an obvious one.`;
  }
  // The structured scope pins the approval down: the agent acts on exactly this destination and these
  // recipients, not on lookalikes from its context. It rides before the draft so the verbatim text stays last.
  const scope = [
    c.destination ? `Destination: ${c.destination}` : '',
    c.recipients?.length ? `To: ${c.recipients.join(', ')}` : '',
    c.url ? `Link: ${c.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const scoped = scope ? `\n${scope}` : '';
  if (c.edited && c.draft) {
    // The note goes before the draft: everything after the blank line is the text to send.
    return `[approval ${card.id}] APPROVED with edits: "${c.title}". The user edited your draft, then tapped ${tapped}. Send exactly the text below, not your original draft, and otherwise do what the card described. Then confirm in one short line.${oldAskNote(age, 'edited')}${scoped}\n\n${c.draft}`;
  }
  const asDrafted = c.draft ? ', sending the draft exactly as it was on the card' : '';
  return `[approval ${card.id}] APPROVED: "${c.title}". The user tapped ${tapped}. Go ahead and do exactly what the card described${asDrafted}, then confirm in one short line.${oldAskNote(age, 'approval')}${scoped}`;
}
