import { describe, expect, test } from 'bun:test';
import { CARD_TTL_MS, cardExpired, issueCard, money, parseIssuedCard, paymentCard, paymentDecision, paymentInput, paymentPrompt, providerFromEnv } from './payments';

const ITEMS = [
  { title: 'Sleeper ticket', price_cents: 2450 },
  { title: 'Coffee', price_cents: 350, quantity: 2 },
];

describe('paymentInput', () => {
  test('totals the receipt and accepts a matching amount', () => {
    const input = paymentInput({ merchant: 'Amtrak', amount_cents: 3150, items: ITEMS });
    expect(input.amount_cents).toBe(3150);
    expect(input.currency).toBe('USD');
    expect(input.items).toHaveLength(2);
    expect(input.cap_cents).toBe(50_000);
  });

  test('the items are the source of truth', () => {
    const input = paymentInput({ merchant: 'Amtrak', items: ITEMS });
    expect(input.amount_cents).toBe(3150);
  });

  test('a total that disagrees with the items is refused', () => {
    expect(() => paymentInput({ merchant: 'Amtrak', amount_cents: 9999, items: ITEMS })).toThrow(/add up to/);
  });

  test('the hard cap applies to the total, in cents', () => {
    expect(() => paymentInput({ merchant: 'Car', amount_cents: 100_000, items: [{ title: 'Car', price_cents: 100_000 }] }, 50_000)).toThrow(/over the \$500\.00/);
    expect(paymentInput({ merchant: 'Car', items: [{ title: 'Car', price_cents: 49_999 }] }, 50_000).amount_cents).toBe(49_999);
  });

  test('rejects missing or malformed lines', () => {
    expect(() => paymentInput({ merchant: '', items: ITEMS })).toThrow(/merchant/);
    expect(() => paymentInput({ merchant: 'X', items: [] })).toThrow(/itemized/);
    expect(() => paymentInput({ merchant: 'X', items: [{ price_cents: 100 }] })).toThrow(/title/);
    expect(() => paymentInput({ merchant: 'X', items: [{ title: 'a', price_cents: -1 }] })).toThrow(/price_cents/);
    expect(() => paymentInput({ merchant: 'X', items: [{ title: 'a', price_cents: 1.5 }] })).toThrow(/price_cents/);
    expect(() => paymentInput({ merchant: 'X', items: [{ title: 'a', price_cents: 1, quantity: 0 }] })).toThrow(/quantity/);
    expect(() => paymentInput({ merchant: 'X', items: [{ title: 'a', price_cents: 0 }] })).toThrow(/more than zero/);
  });

  test('currency must be a code', () => {
    expect(paymentInput({ merchant: 'X', currency: 'eur', items: [{ title: 'a', price_cents: 1 }] }).currency).toBe('EUR');
    expect(() => paymentInput({ merchant: 'X', currency: 'euros', items: [{ title: 'a', price_cents: 1 }] })).toThrow(/three-letter/);
  });
});

describe('paymentCard', () => {
  test('is an itemized, capped payment card', () => {
    const card = paymentCard(paymentInput({ merchant: 'Amtrak', items: ITEMS }), { cardProvider: 'privacy' });
    expect(card.type).toBe('payment');
    expect(card.status).toBe('pending');
    expect(card.title).toBe('Pay $31.50 to Amtrak');
    expect(card.action_label).toBe('Approve & pay $31.50');
    expect(card.line_items).toHaveLength(2);
    expect(card.cap_cents).toBe(50_000);
    expect(card.body).toContain('single-use privacy card');
  });

  test('without a provider it is a plain spend authorization', () => {
    const card = paymentCard(paymentInput({ merchant: 'Amtrak', items: ITEMS }));
    expect(card.body).toContain('No card provider');
  });

  test('never carries card details', () => {
    const card = paymentCard(paymentInput({ merchant: 'Amtrak', items: ITEMS }), { cardProvider: 'stripe' });
    const json = JSON.stringify(card);
    expect(json).not.toMatch(/\bpan\b|cvv|cvc|card_number/i);
  });
});

describe('paymentDecision', () => {
  test('only approve and decline are decisions', () => {
    expect(paymentDecision('approve')).toEqual({ approved: true });
    expect(paymentDecision('decline')).toEqual({ approved: false });
    expect(() => paymentDecision('choose')).toThrow(/invalid/);
  });
});

describe('paymentPrompt', () => {
  const card = paymentCard(paymentInput({ merchant: 'Amtrak', items: ITEMS }));

  test('declining tells the agent to stop', () => {
    const p = paymentPrompt(card, 'card-1', { approved: false });
    expect(p).toContain('[payment card-1] DECLINED');
    expect(p).toContain('$31.50');
    expect(p).toContain('Do not buy it');
  });

  test('approval with a filled card says where the card is and what it is good for', () => {
    const p = paymentPrompt(card, 'card-1', { approved: true }, { cardFilled: true, last4: '4242' });
    expect(p).toContain('APPROVED');
    expect(p).toContain('ending 4242');
    expect(p).toContain('one transaction');
    expect(p).toContain('Never repeat the card number');
  });

  test('approval without a card authorizes exactly the total', () => {
    const p = paymentPrompt(card, 'card-1', { approved: true });
    expect(p).toContain('authorized spending up to $31.50');
    expect(p).toContain('request_payment for the difference');
  });
});

describe('providerFromEnv', () => {
  test('no key means no provider', () => {
    expect(providerFromEnv({})).toBeNull();
    expect(providerFromEnv({ DUET_CARD_PROVIDER: 'privacy' })).toBeNull();
  });

  test('reads the provider, key and base', () => {
    expect(providerFromEnv({ DUET_CARD_KEY: 'k' })).toEqual({ name: 'privacy', key: 'k', baseUrl: 'https://api.privacy.com' });
    expect(providerFromEnv({ DUET_CARD_KEY: 'k', DUET_CARD_PROVIDER: 'stripe' })?.baseUrl).toBe('https://api.stripe.com');
    expect(providerFromEnv({ DUET_CARD_KEY: 'k', DUET_CARD_PROVIDER: 'privacy', DUET_CARD_URL: 'http://localhost:9999/' })?.baseUrl).toBe('http://localhost:9999');
  });

  test('an unknown provider falls back to privacy rather than throwing', () => {
    expect(providerFromEnv({ DUET_CARD_KEY: 'k', DUET_CARD_PROVIDER: 'bank' })?.name).toBe('privacy');
  });

  test('generic needs a URL', () => {
    expect(() => providerFromEnv({ DUET_CARD_KEY: 'k', DUET_CARD_PROVIDER: 'generic' })).toThrow(/DUET_CARD_URL/);
    expect(providerFromEnv({ DUET_CARD_KEY: 'k', DUET_CARD_PROVIDER: 'generic', DUET_CARD_URL: 'http://x' })?.name).toBe('generic');
  });
});

describe('parseIssuedCard', () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  test('reads Privacy.com shape', () => {
    const card = parseIssuedCard({ data: { pan: '4111 1111 1111 4242', cvv: '123', exp_month: 12, exp_year: 2027 } }, now);
    expect(card.number).toBe('4111111111114242');
    expect(card.last4).toBe('4242');
    expect(card.expMonth).toBe(12);
    expect(card.expiresAt).toBe(now + CARD_TTL_MS);
  });

  test('reads Stripe details shape', () => {
    const card = parseIssuedCard({ number: '4242424242424242', cvc: '999', exp_month: 1, exp_year: 2028 }, now);
    expect(card.cvv).toBe('999');
  });

  test('reads a single expiry string', () => {
    const card = parseIssuedCard({ number: '5555555555554444', cvv: '737', expiry: '08/27' }, now);
    expect(card.expMonth).toBe(8);
    expect(card.expYear).toBe(2027);
  });

  test('refuses a card it cannot use, or one already expired', () => {
    expect(() => parseIssuedCard({ cvv: '123', exp_month: 1, exp_year: 2028 }, now)).toThrow(/card number/);
    expect(() => parseIssuedCard({ number: '4242424242424242', exp_month: 1, exp_year: 2028 }, now)).toThrow(/security code/);
    expect(() => parseIssuedCard({ number: '4242424242424242', cvv: '123', exp_month: 1, exp_year: 2020 }, now)).toThrow(/expired/);
    expect(() => parseIssuedCard({ number: '4242424242424242', cvv: '123' }, now)).toThrow(/expiry/);
  });

  test('expires an hour after issue', () => {
    const card = parseIssuedCard({ number: '4242424242424242', cvv: '123', exp_month: 12, exp_year: 2030 }, now);
    expect(cardExpired(card, now + CARD_TTL_MS - 1)).toBe(false);
    expect(cardExpired(card, now + CARD_TTL_MS)).toBe(true);
  });
});

describe('money', () => {
  test('formats cents, including currencies Intl knows', () => {
    expect(money(2450)).toBe('$24.50');
    expect(money(0)).toBe('$0.00');
    expect(money(2450, 'EUR')).toBe('€24.50');
    expect(money(100, 'ZZZ')).toContain('1.00');
  });
});

// The card API is real money: a wrong spend_limit or amount is not a rendering bug. These stub fetch and assert the
// exact request each provider gets, so a refactor that widens the cap fails here.
function stubFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
const okJson = (json: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
const CARD = { pan: '4111111111111111', cvv: '123', exp_month: 12, exp_year: 2030 };

describe('issueCard payloads', () => {
  test('privacy: one single-use card capped at exactly the approved total', async () => {
    const s = stubFetch(() => okJson(CARD));
    try {
      const card = await issueCard({ name: 'privacy', key: 'k', baseUrl: 'https://api.privacy.com' }, { amountCents: 64000, currency: 'USD', merchant: 'Health permit' });
      expect(card.last4).toBe('1111');
      expect(s.calls[0]!.url).toBe('https://api.privacy.com/v1/card');
      expect(s.calls[0]!.init.headers.authorization).toBe('Bearer k');
      expect(JSON.parse(s.calls[0]!.init.body)).toEqual({
        type: 'SINGLE_USE',
        memo: 'Hermes Duet: Health permit',
        spend_limit: 64000,
        spend_limit_duration: 'TRANSACTION',
      });
    } finally {
      s.restore();
    }
  });

  test('stripe: a virtual card with an all-time limit of the approved total', async () => {
    const s = stubFetch((url) => (url.includes('/details') ? okJson(CARD) : okJson({ id: 'ic_1' })));
    try {
      await issueCard({ name: 'stripe', key: 'sk', baseUrl: 'https://api.stripe.com' }, { amountCents: 3150, currency: 'USD', merchant: 'Amtrak' });
      const form = new URLSearchParams(s.calls[0]!.init.body);
      expect(form.get('spending_controls[spending_limits][0][amount]')).toBe('3150');
      expect(form.get('spending_controls[spending_limits][0][interval]')).toBe('all_time');
      expect(form.get('currency')).toBe('usd');
      expect(form.get('type')).toBe('virtual');
      expect(s.calls[1]!.url).toContain('/v1/issuing/cards/ic_1/details');
    } finally {
      s.restore();
    }
  });

  test('revolut and the generic proxy get the same cap', async () => {
    const revolut = stubFetch(() => okJson(CARD));
    try {
      await issueCard({ name: 'revolut', key: 'r', baseUrl: 'https://b2b.revolut.com' }, { amountCents: 999, currency: 'EUR', merchant: 'Cafe' });
      expect(JSON.parse(revolut.calls[0]!.init.body)).toEqual({ virtual: true, single_use: true, spend_limit: 999, currency: 'EUR' });
    } finally {
      revolut.restore();
    }
    const generic = stubFetch(() => okJson(CARD));
    try {
      await issueCard({ name: 'generic', key: 'g', baseUrl: 'http://127.0.0.1:9' }, { amountCents: 500, currency: 'USD', merchant: 'Shop' });
      const body = JSON.parse(generic.calls[0]!.init.body);
      expect(body.amount_cents).toBe(500);
      expect(body.single_use).toBe(true);
    } finally {
      generic.restore();
    }
  });

  test('a provider refusal is surfaced, never returned as a card', async () => {
    const s = stubFetch(() => ({ ok: false, status: 402, text: async () => JSON.stringify({ error: { message: 'declined' } }) }));
    try {
      const err = await issueCard({ name: 'privacy', key: 'k', baseUrl: 'https://api.privacy.com' }, { amountCents: 1, currency: 'USD', merchant: 'x' }).catch((e) => e);
      expect(err.message).toContain('privacy refused the card (402)');
      expect(err.message).toContain('declined');
    } finally {
      s.restore();
    }
  });
});
