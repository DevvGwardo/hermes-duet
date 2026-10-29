// Spending money needs a harder gate than the other approvals: a total the user actually saw, an itemized receipt
// that adds up, a hard ceiling per transaction, and a card that exists only long enough to pay once.
//
// Card numbers never leave this module's memory. They are not put on the card, in the database, in the run's context
// or in a log line: the agent is told only that the purchase was approved and (if a provider is configured) that the
// fields were filled in its browser.
import type { CardData, PaymentItem } from '../shared/types';

export const MAX_LINE_ITEMS = 30;
/** Default single-transaction ceiling, in cents. DUET_MAX_TRANSACTION_LIMIT raises or lowers it. */
export const DEFAULT_CAP_CENTS = 50_000;
/** A virtual card is good for this long and then worthless, whether or not it was used. */
export const CARD_TTL_MS = 60 * 60_000;

type Env = Record<string, string | undefined>;

export function money(cents: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max).trim() : '');

function wholeNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

export interface PaymentInput {
  merchant: string;
  amount_cents: number;
  currency: string;
  items: PaymentItem[];
  cap_cents: number;
}

/**
 * Validate a `request_payment` call into the numbers the card shows. The itemized total is the source of truth: an
 * `amount_cents` that disagrees with the items is refused rather than silently approved, because that is exactly how
 * a user ends up paying more than the receipt they read.
 */
export function paymentInput(raw: unknown, capCents = DEFAULT_CAP_CENTS): PaymentInput {
  const src = (raw ?? {}) as Record<string, unknown>;
  const merchant = text(src.merchant, 80);
  if (!merchant) throw new Error('a payment needs a merchant');
  const currency = (text(src.currency, 8) || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a three-letter code like USD');
  const list = Array.isArray(src.items) ? src.items.slice(0, MAX_LINE_ITEMS) : [];
  if (!list.length) throw new Error('a payment needs at least one itemized line');
  const items: PaymentItem[] = list.map((raw2) => {
    const it = (raw2 ?? {}) as Record<string, unknown>;
    const title = text(it.title, 100);
    if (!title) throw new Error('every line needs a title');
    const price = wholeNumber(it.price_cents);
    if (price === null || price < 0) throw new Error(`"${title}" needs a whole price_cents of 0 or more`);
    const qty = it.quantity === undefined ? 1 : wholeNumber(it.quantity);
    if (qty === null || qty < 1 || qty > 99) throw new Error(`"${title}" needs a quantity between 1 and 99`);
    return { title, price_cents: price, ...(qty !== 1 ? { quantity: qty } : {}) };
  });
  const total = items.reduce((sum, it) => sum + it.price_cents * (it.quantity ?? 1), 0);
  if (total <= 0) throw new Error('the total has to be more than zero');
  const claimed = src.amount_cents === undefined ? total : wholeNumber(src.amount_cents);
  if (claimed === null) throw new Error('amount_cents must be a whole number of cents');
  if (claimed !== total) throw new Error(`the total says ${money(claimed, currency)} but the items add up to ${money(total, currency)}`);
  const cap = Number.isFinite(capCents) && capCents > 0 ? Math.floor(capCents) : DEFAULT_CAP_CENTS;
  if (total > cap) throw new Error(`${money(total, currency)} is over the ${money(cap, currency)} per-transaction limit (DUET_MAX_TRANSACTION_LIMIT)`);
  return { merchant, amount_cents: total, currency, items, cap_cents: cap };
}

/** The card the agent's request_payment posts: itemized, capped, and explicit about what approval means. */
export function paymentCard(input: PaymentInput, opts: { taskId?: string | null; cardProvider?: string | null } = {}): CardData {
  const total = money(input.amount_cents, input.currency);
  const how = opts.cardProvider
    ? `Approving creates a single-use ${opts.cardProvider} card limited to ${total} and types it into the browser.`
    : 'No card provider is configured, so approving authorizes me to spend up to this total; I will still come back if the checkout differs.';
  return {
    type: 'payment',
    title: `Pay ${total} to ${input.merchant}`,
    body: how,
    merchant: input.merchant,
    amount_cents: input.amount_cents,
    currency: input.currency,
    cap_cents: input.cap_cents,
    line_items: input.items,
    action_label: `Approve & pay ${total}`,
    status: 'pending',
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
  };
}

/** Resolve a tap on a payment card. Anything but approve/decline is not a decision. */
export function paymentDecision(action: string): { approved: boolean } {
  if (action === 'approve') return { approved: true };
  if (action === 'decline') return { approved: false };
  throw new Error('invalid action');
}

/**
 * What the agent hears after the user decided. It carries the numbers so the agent can check the checkout matches,
 * and it says plainly whether card fields were filled, because that changes what it should do next.
 */
export function paymentPrompt(card: CardData, cardId: string, decision: { approved: boolean }, opts: { cardFilled?: boolean; last4?: string } = {}): string {
  const total = money(card.amount_cents ?? 0, card.currency ?? 'USD');
  const merchant = card.merchant ?? 'the merchant';
  if (!decision.approved) {
    return `[payment ${cardId}] DECLINED by the user for ${total} at ${merchant}. Do not buy it, and do not look for another way to pay. Offer one alternative in a line if there is an obvious one.`;
  }
  if (opts.cardFilled && opts.last4) {
    return `[payment ${cardId}] APPROVED: ${total} at ${merchant}. A single-use card ending ${opts.last4} is now typed into the checkout in your live browser; it is good for one transaction, for the next hour, and only up to ${total}. Finish the checkout, confirm the charged amount is exactly ${total}, and report the order. Never repeat the card number.`;
  }
  return `[payment ${cardId}] APPROVED: ${total} at ${merchant}. The user authorized spending up to ${total}; this is their approval for a purchase at exactly that total. Go ahead with the checkout they asked for, confirm the final amount is exactly ${total}, and if the site asks for more, stop and send a new request_payment for the difference.`;
}

// ---------------------------------------------------------------------------
// Virtual card providers
// ---------------------------------------------------------------------------

export type ProviderName = 'privacy' | 'stripe' | 'revolut' | 'generic';

export interface ProviderConfig {
  name: ProviderName;
  key: string;
  /** Overridable, mostly so a sandbox or a self-hosted proxy can stand in for the real API. */
  baseUrl: string;
}

const BASES: Record<ProviderName, string> = {
  privacy: 'https://api.privacy.com',
  stripe: 'https://api.stripe.com',
  revolut: 'https://b2b.revolut.com',
  generic: '',
};

/** Providers from the environment. Without a key there is no provider, and approval is a plain spend authorization. */
export function providerFromEnv(env: Env): ProviderConfig | null {
  const key = env.DUET_CARD_KEY?.trim();
  if (!key) return null;
  const raw = (env.DUET_CARD_PROVIDER?.trim() || 'privacy').toLowerCase();
  const name = (['privacy', 'stripe', 'revolut', 'generic'].includes(raw) ? raw : 'privacy') as ProviderName;
  const base = env.DUET_CARD_URL?.trim() || BASES[name];
  if (!base) throw new Error(`DUET_CARD_PROVIDER=${name} needs DUET_CARD_URL`);
  return { name, key, baseUrl: base.replace(/\/$/, '') };
}

export interface IssuedCard {
  number: string;
  cvv: string;
  expMonth: number;
  expYear: number;
  last4: string;
  /** When this runner must stop using (and forget) the card, regardless of the provider's month-level expiry. */
  expiresAt: number;
}

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/**
 * Read a provider's response into the one shape the runner uses. APIs disagree on field names (`pan` vs `number`,
 * `cvv` vs `cvc`) and on expiry (`exp_month`/`exp_year` vs `MM/YY` in one string).
 */
export function parseIssuedCard(json: any, now = Date.now()): IssuedCard {
  const src = json?.data && !Array.isArray(json.data) ? json.data : json;
  const number = digits(src?.pan ?? src?.number ?? src?.card_number ?? src?.cardNumber);
  if (number.length < 12 || number.length > 19) throw new Error('the card provider returned no usable card number');
  const cvv = digits(src?.cvv ?? src?.cvc ?? src?.security_code ?? src?.securityCode);
  if (cvv.length < 3 || cvv.length > 4) throw new Error('the card provider returned no usable security code');
  let expMonth = Number(src?.exp_month ?? src?.expMonth);
  let expYear = Number(src?.exp_year ?? src?.expYear);
  const expRaw = String(src?.expiry ?? src?.exp ?? src?.expiry_date ?? '');
  const m = expRaw.match(/^(\d{1,2})\s*[\/-]\s*(\d{2,4})$/);
  if (m) {
    expMonth = Number(m[1]);
    expYear = Number(m[2].length === 2 ? `20${m[2]}` : m[2]);
  }
  if (!(expMonth >= 1 && expMonth <= 12) || !(expYear >= 2000)) throw new Error('the card provider returned no usable expiry');
  const expiresAt = now + CARD_TTL_MS;
  const endOfMonth = Date.UTC(expYear, expMonth, 1);
  if (endOfMonth < now) throw new Error('the card provider returned an expired card');
  return { number, cvv, expMonth, expYear, last4: number.slice(-4), expiresAt };
}

/** Provider-specific request. Kept small; each branch is the documented "create a single-use virtual card" call. */
export async function issueCard(
  cfg: ProviderConfig,
  input: { amountCents: number; currency: string; merchant: string },
  now = Date.now(),
): Promise<IssuedCard> {
  const memo = `Hermes Duet: ${input.merchant}`.slice(0, 60);
  const limit = String(input.amountCents);
  const call = async (path: string, body: BodyInit, headers: Record<string, string> = {}) => {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, ...headers },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    if (!res.ok) throw new Error(`${cfg.name} refused the card (${res.status}): ${(json?.error?.message ?? json?.message ?? raw).toString().slice(0, 200)}`);
    return json;
  };

  if (cfg.name === 'privacy') {
    const json = await call(
      '/v1/card',
      JSON.stringify({ type: 'SINGLE_USE', memo, spend_limit: input.amountCents, spend_limit_duration: 'TRANSACTION' }),
      { 'content-type': 'application/json' },
    );
    return parseIssuedCard(json, now);
  }
  if (cfg.name === 'stripe') {
    const form = new URLSearchParams();
    form.set('type', 'virtual');
    form.set('currency', input.currency.toLowerCase());
    form.set('status', 'active');
    form.set('metadata[duet_merchant]', input.merchant.slice(0, 100));
    // One authorization for at most the approved total, then the card is done.
    form.set('spending_controls[spending_limits][0][amount]', limit);
    form.set('spending_controls[spending_limits][0][interval]', 'all_time');
    const created = await call('/v1/issuing/cards', form);
    const id = created?.id;
    if (!id) throw new Error('stripe returned no card id');
    const details = await call(`/v1/issuing/cards/${encodeURIComponent(id)}/details?expand[]=number&expand[]=cvc`, '');
    return parseIssuedCard(details, now);
  }
  if (cfg.name === 'revolut') {
    const json = await call(
      '/api/1.0/cards',
      JSON.stringify({ virtual: true, single_use: true, spend_limit: input.amountCents, currency: input.currency }),
      { 'content-type': 'application/json' },
    );
    return parseIssuedCard(json, now);
  }
  // Generic: any proxy that hands back `{ number, cvv, exp_month, exp_year }` for a capped single-use card.
  const json = await call(
    '/cards',
    JSON.stringify({ amount_cents: input.amountCents, currency: input.currency, merchant: input.merchant, single_use: true, expires_in_minutes: CARD_TTL_MS / 60_000 }),
    { 'content-type': 'application/json' },
  );
  return parseIssuedCard(json, now);
}

export function cardExpired(card: IssuedCard, now = Date.now()): boolean {
  return now >= card.expiresAt;
}