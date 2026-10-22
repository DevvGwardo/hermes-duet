// Pure rules for deciding an approval card, kept out of runner.ts so they can be tested without a database or
// Hermes. A Duet approval may carry `draft`: the exact text the agent will send. The user can edit it on the
// card before approving; the edited text replaces the draft on the card and goes back to the agent verbatim.
import type { CardData, Item } from '../shared/types';
import type { PushPayload } from './push';

export const DRAFT_MAX = 8000;

export interface ApprovalDecision {
  approved: boolean;
  /** Set only when the user changed the draft: the text the agent must send instead of its own. */
  draft?: string;
}

/** Resolve a tap on an approval card. `value` is the draft as the user left it (absent from push actions). */
export function approvalDecision(card: CardData, action: string, value: unknown): ApprovalDecision {
  if (action !== 'approve' && action !== 'decline') throw new Error('invalid action');
  if (action === 'decline') return { approved: false };
  // Hermes-native approvals have no draft to edit; their decision is a plain once/deny.
  if (!card.draft || card.hermes || typeof value !== 'string') return { approved: true };
  const text = value.trim();
  if (text === card.draft.trim()) return { approved: true };
  if (!text) throw new Error('the draft is empty');
  if (text.length > DRAFT_MAX) throw new Error('the draft is too long');
  return { approved: true, draft: text };
}

/**
 * The push for an approval card, Duet or Hermes-native. The notification shows only the title, so a card whose
 * substance is in the card itself gets `must_read`: the service worker then offers "Read it first" (opens the
 * card) instead of a one-tap Approve. That covers a Duet draft (text the user never saw would be sent) and every
 * Hermes-native approval (a flagged command would run unseen; the command is only in the card body). Neither
 * the draft nor the command goes into the payload.
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
  };
}

/** The message that resumes the agent's session after an approval decision. */
export function approvalPrompt(card: Item, approved: boolean): string {
  const c = card.card!;
  const tapped = c.action_label || 'Approve';
  if (!approved) {
    return `[approval ${card.id}] NOT NOW: "${c.title}". The user declined for now. Don't do it. Acknowledge in one short line, and offer an alternative only if there's an obvious one.`;
  }
  if (c.edited && c.draft) {
    return `[approval ${card.id}] APPROVED with edits: "${c.title}". The user edited your draft, then tapped ${tapped}. Send exactly the text below, not your original draft, and otherwise do what the card described. Then confirm in one short line.\n\n${c.draft}`;
  }
  const asDrafted = c.draft ? ', sending the draft exactly as it was on the card' : '';
  return `[approval ${card.id}] APPROVED: "${c.title}". The user tapped ${tapped}. Go ahead and do exactly what the card described${asDrafted}, then confirm in one short line.`;
}
