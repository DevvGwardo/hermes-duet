// Server-side "Don't ask again" trust rules engine with hard safety floors.
import type { CardData, TrustRule } from '../shared/types';
import { isTrustCandidateSafe } from '../shared/trust';
import { UserError } from './errors';
import { approvalPolicyRefusal, scanOutbound } from './safety';

export interface TrustEligibilityInput {
  type?: CardData['type'];
  action?: CardData['action'];
  title?: string;
  summary?: string;
  body?: string;
  destination?: string;
  recipients?: string[];
  draft?: string;
  content?: string;
  scan_warning?: string;
  hermes?: CardData['hermes'];
  resume?: boolean;
  rerun?: CardData['rerun'];
}

export function normalizeTrustText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isTrustEligible(input: TrustEligibilityInput): boolean {
  const body = input.summary ?? input.body;
  if (!isTrustCandidateSafe({ ...input, body })) return false;
  if (approvalPolicyRefusal({ action: input.action, title: input.title, summary: body, destination: input.destination, content: input.content, draft: input.draft })) {
    return false;
  }
  const findings = [input.title, body, input.destination, input.draft, input.content]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .flatMap((s) => scanOutbound(s));
  if (findings.length > 0) return false;
  return true;
}

export function trustRuleFromInput(raw: Record<string, unknown>, id: string, createdAt = Date.now()): TrustRule {
  const title_pattern = String(raw.title_pattern ?? raw.label ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  if (!title_pattern) throw new UserError('trust rule needs a pattern or title');
  const destinationRaw = typeof raw.destination === 'string' ? raw.destination.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const destination = destinationRaw || undefined;
  const label = (typeof raw.label === 'string' ? raw.label.replace(/\s+/g, ' ').trim().slice(0, 140) : '') || title_pattern;
  const channel_id = typeof raw.channel_id === 'string' && raw.channel_id.trim() ? raw.channel_id.trim() : null;
  const action = typeof raw.action === 'string' ? (raw.action.trim() as CardData['action']) : 'other';
  if (
    !isTrustEligible({
      type: 'approval',
      action,
      title: title_pattern,
      summary: label,
      destination,
    })
  ) {
    throw new UserError('Actions involving money, messages, deletion, public posts, signing, secrets, or accounts can never skip approval');
  }
  return {
    id,
    label,
    action: 'other',
    ...(destination ? { destination } : {}),
    title_pattern,
    channel_id,
    created_at: createdAt,
  };
}

export function trustRuleFromCard(card: CardData, id: string, channelId?: string | null, createdAt = Date.now()): TrustRule {
  if (!isTrustEligible(card)) {
    throw new UserError('This kind of action always requires explicit approval');
  }
  const title_pattern = card.title.replace(/\s+/g, ' ').trim().slice(0, 140);
  const destination = card.destination?.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
  return {
    id,
    label: destination ? `${title_pattern} (${destination})` : title_pattern,
    action: 'other',
    ...(destination ? { destination } : {}),
    title_pattern,
    channel_id: channelId ?? card.channel_id ?? null,
    created_at: createdAt,
  };
}

export function matchingTrustRule(
  rules: TrustRule[],
  input: {
    action?: CardData['action'];
    title: string;
    summary?: string;
    destination?: string;
    recipients?: string[];
    draft?: string;
    content?: string;
    channelId?: string | null;
  },
): TrustRule | null {
  if (!isTrustEligible({ type: 'approval', ...input })) return null;
  const titleNorm = normalizeTrustText(input.title);
  const destNorm = input.destination ? normalizeTrustText(input.destination) : '';
  for (const rule of rules) {
    if (rule.channel_id && input.channelId && rule.channel_id !== input.channelId) continue;
    if (rule.channel_id && !input.channelId) continue;
    if (rule.destination && normalizeTrustText(rule.destination) !== destNorm) continue;
    const pat = normalizeTrustText(rule.title_pattern);
    if (!pat) continue;
    if (titleNorm === pat || titleNorm.startsWith(`${pat} `) || (pat.length >= 8 && titleNorm.includes(pat))) {
      return rule;
    }
  }
  return null;
}
