// Deterministic trust layer around approvals. This module is pure (no DB, no Hermes) so it can be unit-tested:
// it scans outbound text for secrets and enforces the hard-block policy that no approval card can override.
// The model is only ever *instructed* to ask first; these checks are the floor that holds when it doesn't.

export type ScanTier = 'never_share' | 'needs_consent';

export interface ScanFinding {
  tier: ScanTier;
  /** Human label, e.g. "card number". Never the secret itself. */
  label: string;
  /** First/last few chars only, so logs and errors never carry the full value. */
  redacted: string;
}

export interface PolicyBlock {
  id: string;
  title: string;
  detail: string;
}

/**
 * What Hermes Duet always refuses, even with approval. The app's Settings screen lists these verbatim
 * (GET /api/policy), so keep titles short and details one line.
 */
export const HARD_BLOCKS: PolicyBlock[] = [
  {
    id: 'bank-wire',
    title: 'Bank and wire transfers',
    detail: 'Moving money between banks (wires, ACH, SWIFT) is never done from here.',
  },
  {
    id: 'securities-crypto',
    title: 'Securities and crypto trading',
    detail: 'Buying, selling or swapping stocks, options or crypto is never done from here.',
  },
  {
    id: 'account-access',
    title: "Logging into someone else's account",
    detail: 'Signing in as another person, or using their credentials, is never done from here.',
  },
  {
    id: 'credential-change',
    title: 'Password and 2FA changes',
    detail: 'Changing passwords, 2FA/MFA or recovery secrets is never done from here.',
  },
  {
    id: 'account-creation',
    title: 'Creating accounts',
    detail: 'Opening new accounts, profiles or logins anywhere is never done from here.',
  },
];

export type ApprovalAction = 'send_email' | 'send_message' | 'post' | 'delete' | 'sign' | 'pay' | 'other';

const ACTIONS: readonly ApprovalAction[] = ['send_email', 'send_message', 'post', 'delete', 'sign', 'pay', 'other'];

export interface ValidatedApproval {
  action: ApprovalAction;
  destination?: string;
  recipients: string[];
  content?: string;
  url?: string;
}

/** Only this much text is scanned: a pasted dump must not turn the check into a slowdown. */
export const SCAN_MAX = 20_000;
/** Cap on findings per scan, so a dumped file can't flood the card or the logs. */
const FINDINGS_MAX = 10;

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function cleanStr(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max).trim() : '';
}

function luhnOk(digits: string): boolean {
  // Standard Luhn: every second digit from the right doubles (minus 9 past 9); the total mod 10 is 0.
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN checksum: move the first four chars to the end, expand letters (A=10..Z=35), mod 97 must be 1. */
function ibanOk(compact: string): boolean {
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : ch.charCodeAt(0) - 48;
    if (code < 0 || code > 35) return false;
    remainder = (remainder * (code > 9 ? 100 : 10) + code) % 97;
  }
  return remainder === 1;
}

function redactEnds(value: string, first: number, last: number): string {
  if (value.length <= first + last) return `${value.slice(0, first)}…`;
  return `${value.slice(0, first)}…${value.slice(-last)}`;
}

/**
 * Card numbers (13-19 digits, spaces/dashes ignored) that pass Luhn. The checksum is what separates a real
 * number from order ids, dates and phone numbers, which almost never validate; digit-count (13+) plus
 * letter-adjacency rejection keeps phone numbers and alnum order ids out before that.
 *
 * Groups of digits are scanned rather than matching a fixed `{13,19}` run so a preceding number separated by
 * a space (e.g. `"ZIP 90210 4111-1111-1111-1111"` or `"qty 12 4111 1111 1111 1111"`) cannot swallow and hide
 * the real card number after it, while still rejecting >19-digit single numbers and alnum-glued IDs.
 */
function findCards(text: string, out: ScanFinding[]) {
  const groups: { start: number; end: number; digits: string }[] = [];
  const groupRe = /\d+/g;
  for (let gm = groupRe.exec(text); gm; gm = groupRe.exec(text)) {
    groups.push({ start: gm.index, end: gm.index + gm[0].length, digits: gm[0] });
  }
  if (groups.length === 0) return;

  // Partition digit groups into maximal runs connected only by single-line spaces or hyphens.
  let runStart = 0;
  const seen = new Set<string>();
  while (runStart < groups.length && out.length < FINDINGS_MAX) {
    let runEnd = runStart;
    while (runEnd + 1 < groups.length && /^[ \-]+$/.test(text.slice(groups[runEnd]!.end, groups[runEnd + 1]!.start))) {
      runEnd++;
    }

    const totalDigits = groups.slice(runStart, runEnd + 1).reduce((n, g) => n + g.digits.length, 0);
    if (runStart === runEnd) {
      // Single contiguous digit token: never slice substrings out of an oversized digit run (>19 digits).
      const g = groups[runStart]!;
      const before = g.start > 0 ? text[g.start - 1]! : '';
      const after = g.end < text.length ? text[g.end]! : '';
      const adjacent = /[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after);
      if (!adjacent && g.digits.length >= 13 && g.digits.length <= 19 && !/^(\d)\1+$/.test(g.digits) && luhnOk(g.digits)) {
        const redacted = redactEnds(g.digits, 4, 4);
        if (!seen.has(redacted)) {
          seen.add(redacted);
          out.push({ tier: 'never_share', label: 'card number', redacted });
        }
      }
    } else if (totalDigits >= 13) {
      // Multi-group run (e.g. "4111-1111-1111-1111" or "ZIP 90210 4111-1111-1111-1111").
      // Score all Luhn-valid group spans 13..19 digits so genuine PAN spans win cleanly over accidental overlaps.
      type Candidate = { i: number; j: number; digits: string; score: number };
      const candidates: Candidate[] = [];
      for (let i = runStart; i <= runEnd; i++) {
        const gStart = groups[i]!;
        const before = gStart.start > 0 ? text[gStart.start - 1]! : '';
        if (/[0-9A-Za-z]/.test(before)) continue;
        // Do not start inside the middle of a hyphenated chain ("...-1111-1111").
        const sepBefore = i > runStart ? text.slice(groups[i - 1]!.end, gStart.start) : '';
        if (i > runStart && sepBefore.includes('-')) continue;

        let digits = '';
        for (let j = i; j <= runEnd; j++) {
          const gEnd = groups[j]!;
          digits += gEnd.digits;
          if (digits.length > 19) break;
          if (digits.length < 13) continue;
          const after = gEnd.end < text.length ? text[gEnd.end]! : '';
          if (/[0-9A-Za-z]/.test(after)) continue;
          // Do not truncate before a trailing hyphenated group unless no longer span includes it.
          const sepAfter = j < runEnd ? text.slice(gEnd.end, groups[j + 1]!.start) : '';
          if (j < runEnd && sepAfter.includes('-')) continue;
          if (/^(\d)\1+$/.test(digits) || !luhnOk(digits)) continue;

          // Compute uniformity / boundary score to prefer real PANs over accidental surrounding numbers.
          let sameSep = true;
          const firstSep = j > i ? text.slice(groups[i]!.end, groups[i + 1]!.start) : '';
          for (let k = i + 1; k < j; k++) {
            if (text.slice(groups[k]!.end, groups[k + 1]!.start) !== firstSep) {
              sameSep = false;
              break;
            }
          }
          let score = 0;
          if (i === runStart) score += 1;
          if (j === runEnd) score += 2;
          if (sepBefore && !firstSep.includes(sepBefore.trim() || ' ')) score += 3;
          if (sepAfter && !firstSep.includes(sepAfter.trim() || ' ')) score += 3;
          if (sameSep) score += 2;
          if (digits.length === 15 || digits.length === 16) score += 2;
          if (/^[23456]/.test(digits)) score += 2;
          score += digits.length / 100;
          candidates.push({ i, j, digits, score });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const used = new Array<boolean>(runEnd - runStart + 1).fill(false);
      for (const c of candidates) {
        if (out.length >= FINDINGS_MAX) break;
        let overlaps = false;
        for (let k = c.i; k <= c.j; k++) {
          if (used[k - runStart]) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;
        for (let k = c.i; k <= c.j; k++) used[k - runStart] = true;
        const redacted = redactEnds(c.digits, 4, 4);
        if (!seen.has(redacted)) {
          seen.add(redacted);
          out.push({ tier: 'never_share', label: 'card number', redacted });
        }
      }
    }

    runStart = runEnd + 1;
  }
}

/** Dashed US SSN with SSA area/group/serial guards, so dates and phone numbers don't match. */
const SSN_RE = /\b(?!000|666|9\d{2})([0-8]\d{2})-(?!00)(\d{2})-(?!0000)(\d{4})\b/g;

/** IBAN candidates; every one is checksum-verified, which is what rules out lookalikes. The last paper-format
 * group can be short (a DE IBAN ends "...0130 00"), so it allows a short tail after the full groups. */
const IBAN_RE = /\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4})+(?: ?[A-Z0-9]{1,4})?\b/gi;

const PEM_RE = /-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----(?:[\s\S]*?-----END (?:[A-Z0-9 ]* )?PRIVATE KEY-----)?/g;
const AWS_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
// Distinctive prefixes only: never appear in prose, and long trailing bodies rule out typos.
const SK_RE = /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const GITHUB_RE = /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g;
const GITHUB_PAT_RE = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g;

/**
 * Scan outbound text for secrets and sensitive identifiers. Never returns a full secret: every finding carries
 * only a label and a first/last redaction. Unknown/non-string input scans as empty.
 */
export function scanOutbound(text: unknown): ScanFinding[] {
  if (typeof text !== 'string' || !text) return [];
  const src = text.slice(0, SCAN_MAX);
  const out: ScanFinding[] = [];
  const push = (f: ScanFinding) => {
    if (out.length < FINDINGS_MAX) out.push(f);
  };

  findCards(src, out);

  SSN_RE.lastIndex = 0;
  for (let m = SSN_RE.exec(src); m && out.length < FINDINGS_MAX; m = SSN_RE.exec(src)) {
    push({ tier: 'never_share', label: 'US Social Security number', redacted: `***-**-${m[3]}` });
  }

  IBAN_RE.lastIndex = 0;
  const seenIban = new Set<string>();
  for (let m = IBAN_RE.exec(src); m && out.length < FINDINGS_MAX; m = IBAN_RE.exec(src)) {
    const compact = m[0].replace(/ /g, '').toUpperCase();
    // Paper format allows the spaces matched above; the compact form is 15-34 alnum with the checksum intact.
    if (compact.length < 15 || compact.length > 34 || !/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(compact)) continue;
    if (!ibanOk(compact)) continue;
    // An IBAN is routinely shared to *receive* money, so it warns instead of blocking: the user decides on the card.
    const redacted = redactEnds(compact, 4, 4);
    if (seenIban.has(redacted)) continue;
    seenIban.add(redacted);
    push({ tier: 'needs_consent', label: 'IBAN', redacted });
  }

  PEM_RE.lastIndex = 0;
  const pemMatch = PEM_RE.exec(src);
  if (pemMatch) {
    push({
      tier: 'never_share',
      label: 'private key',
      redacted: pemMatch[0].includes('-----END ') ? '-----BEGIN PRIVATE KEY…END PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY…',
    });
  }

  AWS_RE.lastIndex = 0;
  for (let m = AWS_RE.exec(src); m && out.length < FINDINGS_MAX; m = AWS_RE.exec(src)) {
    push({ tier: 'never_share', label: 'AWS access key', redacted: redactEnds(m[0], 4, 4) });
  }

  SK_RE.lastIndex = 0;
  for (let m = SK_RE.exec(src); m && out.length < FINDINGS_MAX; m = SK_RE.exec(src)) {
    push({ tier: 'never_share', label: 'API key', redacted: redactEnds(m[0], 3, 4) });
  }

  for (const re of [GITHUB_RE, GITHUB_PAT_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m && out.length < FINDINGS_MAX; m = re.exec(src)) {
      push({ tier: 'never_share', label: 'GitHub token', redacted: redactEnds(m[0], 4, 4) });
    }
  }

  return out;
}

export interface PolicyInput {
  action?: string;
  title?: string;
  summary?: string;
  destination?: string;
  content?: string;
  draft?: string;
}

// Each block pairs with conservative patterns: verb + object must both be present, so an ordinary
// "delete the draft", "sign the NDA" or "post the update" never matches.
const POLICY_PATTERNS: { id: string; res: RegExp[] }[] = [
  {
    id: 'bank-wire',
    res: [
      /\bwire transfer\b/,
      /\bwire (money|funds|cash)\b/,
      /\bbank transfer\b/,
      /\bach\b.{0,20}\btransfer\b/,
      /\bswift\b.{0,20}\b(transfer|payment|wire)\b/,
      /\bwestern union\b/,
      /\bmoneygram\b/,
      /\bsend\b.{0,30}\ba?\s?wire\b/,
      /\brouting number\b.{0,40}\b(transfer|send|wire)\b/,
    ],
  },
  {
    id: 'securities-crypto',
    res: [
      /\b(buy|buying|sell|selling|trade|trading|short|shorting)\b.{0,40}\b(stocks?|shares?|options?|bonds?|etfs?|mutual funds?|securities|crypto(currency)?|bitcoin|\bbtc\b|\beth\b|ethereum|solana|dogecoin|litecoin|stablecoins?|altcoins?)\b/,
      /\b(stocks?|shares?|options?|bonds?|etfs?|mutual funds?|securities|crypto(currency)?|bitcoin|\bbtc\b|\beth\b|ethereum|solana)\b.{0,40}\b(buy|sell|trade|short)\b/,
      /\bswap\b.{0,20}\b(crypto|tokens?|\beth\b|\bsol\b)\b/,
    ],
  },
  {
    id: 'account-access',
    res: [
      /\blog ?in\b.{0,30}\b(as|into|to)\b.{0,30}(someone else|another person|their|his|her)\b/,
      /\blog ?(in|into|on)\b.{0,30}(someone else'?s|another person'?s|their|his|her) account\b/,
      /\bimpersonat\w*\b/,
      /\buse\b.{0,30}(someone else'?s|another person'?s|their|his|her) (password|credential|login|account)\b/,
    ],
  },
  {
    id: 'credential-change',
    res: [
      /\b(change|reset|rotate|update)\b.{0,30}\b(password|passcode|2fa|two[- ]factor|mfa|totp|authenticator|recovery (key|code|phrase)|security question|api (key|secret))\b/,
      /\bdisable\b.{0,20}\b(2fa|two[- ]factor|mfa|authenticator)\b/,
    ],
  },
  {
    id: 'account-creation',
    res: [
      /\b(create|open|register|set ?up)\b.{0,30}\b(accounts?|profiles?|logins?|user accounts?)\b/,
      /\bopen\b.{0,20}\b(bank|brokerage|trading|crypto|email) account\b/,
      /\bsign ?up\b.{0,20}\bfor\b/,
    ],
  },
];

const BLOCK_BY_ID = new Map(HARD_BLOCKS.map((b) => [b.id, b]));

/**
 * A short refusal reason when this approval is in a hard-blocked category, else null. Matching is deliberately
 * conservative (verb + object within a short window) so the blocks never catch the ordinary deletes, signs and
 * posts that request_approval exists for.
 */
export function approvalPolicyRefusal(input: PolicyInput): string | null {
  const hay = [input.title, input.summary, input.destination, input.content, input.draft]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  if (!hay.trim()) return null;
  for (const { id, res } of POLICY_PATTERNS) {
    if (res.some((re) => re.test(hay))) {
      const block = BLOCK_BY_ID.get(id);
      return `Refused: ${block?.title ?? id} — this is always refused, even with approval. ${block?.detail ?? ''}`.trim();
    }
  }
  return null;
}

const SEND_ACTIONS: readonly ApprovalAction[] = ['send_email', 'send_message'];
const DESTINATION_REQUIRED: readonly ApprovalAction[] = ['send_email', 'send_message', 'post', 'delete', 'sign'];

const MAX_RECIPIENTS = 20;
const MAX_RECIPIENT_LEN = 200;
const MAX_DESTINATION_LEN = 300;
const MAX_CONTENT_LEN = 8000;
const MAX_URL_LEN = 2000;

/** Shape-check the structured approval fields. Unknown actions fall back to `other`, never throw. */
export function validateApprovalFields(raw: unknown): ValidatedApproval {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const actionRaw = typeof r.action === 'string' ? r.action.trim() : '';
  const action: ApprovalAction = (ACTIONS as readonly string[]).includes(actionRaw) ? (actionRaw as ApprovalAction) : 'other';

  let destination: string | undefined;
  const destRaw = cleanStr(r.destination, MAX_DESTINATION_LEN);
  if (destRaw) {
    if (CONTROL_CHARS.test(destRaw)) throw new Error('destination must not contain control characters');
    destination = destRaw;
  }
  if (DESTINATION_REQUIRED.includes(action) && !destination) {
    throw new Error(`request_approval needs destination for ${action} (where it happens: a host, app, or channel)`);
  }

  let list: unknown[] = [];
  if (Array.isArray(r.recipients)) list = r.recipients;
  else if (typeof r.recipients === 'string' && r.recipients.trim()) list = r.recipients.split(',');
  const recipients = list
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .slice(0, MAX_RECIPIENTS + 1);
  if (list.filter((x) => String(x ?? '').trim()).length > MAX_RECIPIENTS) {
    throw new Error(`request_approval takes at most ${MAX_RECIPIENTS} recipients`);
  }
  for (const rc of recipients) {
    if (rc.length > MAX_RECIPIENT_LEN) throw new Error('each recipient must be 200 characters or fewer');
    if (CONTROL_CHARS.test(rc)) throw new Error('recipients must not contain control characters');
  }
  if (SEND_ACTIONS.includes(action) && recipients.length === 0) {
    throw new Error(`request_approval needs at least one recipient for ${action}`);
  }

  let content: string | undefined;
  if (r.content !== undefined && r.content !== null && String(r.content).trim() !== '') {
    const c = String(r.content).trim();
    if (c.length > MAX_CONTENT_LEN) throw new Error('content is too long (max 8000 characters)');
    content = c;
  }

  let url: string | undefined;
  const urlRaw = cleanStr(r.url, MAX_URL_LEN);
  if (urlRaw) {
    if (CONTROL_CHARS.test(urlRaw)) throw new Error('url must not contain control characters');
    let parsed: URL | null = null;
    try {
      parsed = new URL(urlRaw);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new Error('url must be an http(s) URL');
    }
    url = parsed.href;
  }

  return { action, destination, recipients, content, url };
}
