// Pure eligibility rules for "Don't ask again" trust exceptions. Shared between server and web so the UI never
// offers "Approve & don't ask again" on cards that the server refuses to remember.
import type { CardData } from './types';

export interface TrustCandidate {
  type?: CardData['type'];
  action?: CardData['action'];
  title?: string;
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

/**
 * Actions that look like spending, outward messaging, deletion, public posting, signing, or account changes must
 * ALWAYS prompt the user even if miscategorized as action="other".
 */
const UNSAFE_ACTION_WORDS =
  /\b(pay|payment|purchase|buy|spend|checkout|charge|invoice|transfer|wire|send|email|mail|reply|text|message|dm|sms|post|publish|tweet|share|delete|remove|drop|wipe|erase|destroy|sign|contract|agreement|password|passcode|2fa|mfa|totp|credential|account|login|token|secret)\b/i;

export function isTrustCandidateSafe(input: TrustCandidate): boolean {
  if (input.type && input.type !== 'approval') return false;
  if (input.hermes || input.resume || input.rerun) return false;
  if (input.scan_warning) return false;
  if (input.recipients && input.recipients.length > 0) return false;
  // Only `action: 'other'` (or unset, which validates to 'other') can ever qualify for "Don't ask again".
  if (input.action && input.action !== 'other') return false;
  const text = [input.title, input.body, input.destination, input.draft, input.content].filter(Boolean).join(' ');
  if (!input.title?.trim()) return false;
  if (UNSAFE_ACTION_WORDS.test(text)) return false;
  return true;
}
