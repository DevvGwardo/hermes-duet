import { expect, test } from 'bun:test';
import { CARD_TTL_MS, issueCard, type ProviderConfig } from './payments';

const NOW = Date.UTC(2026, 0, 15);
const cfg = (name: ProviderConfig['name']): ProviderConfig => ({ name, key: 'k-test', baseUrl: 'https://cards.example' });

interface Seen {
  url: string;
  init: any;
}
function stubFetch(handler: (seen: Seen) => any) {
  const calls: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const seen = { url: String(url), init };
    calls.push(seen);
    return handler(seen);
  }) as any;
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}
const ok = (json: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });

test('privacy issues a single-use card capped at the approved total', async () => {
  const s = stubFetch(() => ok({ card_number: '4111 1111 1111 1111', security_code: '123', expiry: '12/30' }));
  try {
    const card = await issueCard(cfg('privacy'), { amountCents: 5000, currency: 'USD', merchant: 'Deli' }, NOW);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe('https://cards.example/v1/card');
    const body = JSON.parse(s.calls[0].init.body);
    expect(body.type).toBe('SINGLE_USE');
    expect(body.spend_limit).toBe(5000);
    expect(s.calls[0].init.headers.authorization).toBe('Bearer k-test');
    expect(card.last4).toBe('1111');
    expect(card.expiresAt).toBe(NOW + CARD_TTL_MS);
  } finally {
    s.restore();
  }
});

test('stripe creates a virtual card with an all-time spending limit, then reads its details', async () => {
  const s = stubFetch((seen) =>
    ok(seen.url.includes('/details') ? { number: '4242424242424242', cvc: '321', exp_month: 12, exp_year: 2030 } : { id: 'card_1' }),
  );
  try {
    const card = await issueCard(cfg('stripe'), { amountCents: 2500, currency: 'USD', merchant: 'Deli' }, NOW);
    expect(s.calls).toHaveLength(2);
    const form = new URLSearchParams(s.calls[0].init.body);
    expect(form.get('spending_controls[spending_limits][0][amount]')).toBe('2500');
    expect(form.get('spending_controls[spending_limits][0][interval]')).toBe('all_time');
    expect(card.last4).toBe('4242');
  } finally {
    s.restore();
  }
});

test('revolut requests a capped single-use card and reads a data envelope', async () => {
  const s = stubFetch(() => ok({ data: { pan: '5555555555554444', cvv: '456', exp: '12/30' } }));
  try {
    const card = await issueCard(cfg('revolut'), { amountCents: 999, currency: 'USD', merchant: 'Deli' }, NOW);
    const body = JSON.parse(s.calls[0].init.body);
    expect(body.single_use).toBe(true);
    expect(body.spend_limit).toBe(999);
    expect(card.last4).toBe('4444');
  } finally {
    s.restore();
  }
});

test('generic proxy posts amount, merchant and a one-hour expiry', async () => {
  const s = stubFetch(() => ok({ cardNumber: '4012888888881881', securityCode: '7890', expiry_date: '12/30' }));
  try {
    await issueCard(cfg('generic'), { amountCents: 100, currency: 'USD', merchant: 'Deli' }, NOW);
    expect(s.calls[0].url).toBe('https://cards.example/cards');
    const body = JSON.parse(s.calls[0].init.body);
    expect(body.amount_cents).toBe(100);
    expect(body.expires_in_minutes).toBe(60);
  } finally {
    s.restore();
  }
});

test('a provider refusal names the provider and status, and issues nothing', async () => {
  const s = stubFetch(() => ({ ok: false, status: 402, text: async () => '{"message":"no funds"}' }));
  try {
    await expect(issueCard(cfg('privacy'), { amountCents: 1, currency: 'USD', merchant: 'Deli' }, NOW)).rejects.toThrow(/privacy refused.*402/);
  } finally {
    s.restore();
  }
});

test('expired and malformed cards are rejected, never returned', async () => {
  const s = stubFetch(() => ok({ number: '4111111111111111', cvv: '123', exp_month: 1, exp_year: 2020 }));
  try {
    await expect(issueCard(cfg('privacy'), { amountCents: 1, currency: 'USD', merchant: 'Deli' }, NOW)).rejects.toThrow(/expired/);
  } finally {
    s.restore();
  }
  const bad = stubFetch(() => ok({ number: '123', cvv: '1' }));
  try {
    await expect(issueCard(cfg('privacy'), { amountCents: 1, currency: 'USD', merchant: 'Deli' }, NOW)).rejects.toThrow(/no usable card number/);
  } finally {
    bad.restore();
  }
});
