// The deterministic floor around approvals: secrets are caught even when the model forgets to ask carefully,
// and some actions are refused no matter what. Every finding redacts: the full secret never comes back out.
import { expect, test } from 'bun:test';
import { HARD_BLOCKS, approvalPolicyRefusal, scanOutbound, validateApprovalFields } from './safety';

test('a real card number is caught, with spaces or dashes, and a bad checksum is not', () => {
  for (const num of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111']) {
    const found = scanOutbound(`please charge ${num} today`);
    expect(found.some((f) => f.label === 'card number' && f.tier === 'never_share')).toBe(true);
  }
  // One digit off: the checksum fails, so it is not a card number.
  expect(scanOutbound('please charge 4111111111111112 today').filter((f) => f.label === 'card number')).toEqual([]);
});

test('findings redact: the full secret never comes back', () => {
  const secret = '4111111111111111';
  const [found] = scanOutbound(`charge ${secret}`).filter((f) => f.label === 'card number');
  expect(found).toBeTruthy();
  expect(found!.redacted).not.toContain(secret);
  expect(found!.redacted.length).toBeLessThan(secret.length);
  expect(found!.redacted).toContain(secret.slice(-4));
});

test('SSN, IBAN, private keys and API keys are all caught', () => {
  const ssn = scanOutbound('My SSN is 219-09-9999, keep it safe');
  expect(ssn.some((f) => f.label === 'US Social Security number' && f.tier === 'never_share')).toBe(true);
  expect(ssn[0]!.redacted).not.toContain('219-09-9999');
  expect(ssn[0]!.redacted).toContain('9999');

  const iban = scanOutbound('Pay to DE89 3704 0044 0532 0130 00 please');
  expect(iban.some((f) => f.label === 'IBAN' && f.tier === 'needs_consent')).toBe(true);

  const pem = scanOutbound('key:\n-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----');
  expect(pem.some((f) => f.label === 'private key' && f.tier === 'never_share')).toBe(true);

  const aws = scanOutbound('deploy with AKIAIOSFODNN7EXAMPLE in eu-west-1');
  expect(aws.some((f) => f.label === 'AWS access key' && f.tier === 'never_share')).toBe(true);

  const sk = scanOutbound('the key is sk-proj-abcdefghijklmnop1234 ok?');
  expect(sk.some((f) => f.label === 'API key' && f.tier === 'never_share')).toBe(true);

  const gh = scanOutbound('token ghp_abcdefghij1234567890ABCD leaked');
  expect(gh.some((f) => f.label === 'GitHub token' && f.tier === 'never_share')).toBe(true);
});

test('ordinary prose, dates, phone numbers and order ids are left alone', () => {
  for (const text of [
    'Call me at 415-555-1234 tomorrow',
    'order 12345 shipped, tracking 1Z9999999999999999',
    'meeting on 2026-11-10 at 3pm',
    'See you tomorrow, bring the report',
    'version 2.4.1 is out, build 987654',
  ]) {
    expect(scanOutbound(text)).toEqual([]);
  }
  expect(scanOutbound('')).toEqual([]);
  expect(scanOutbound(undefined)).toEqual([]);
});

test('every hard-block category is refused', () => {
  const cases: [string, Record<string, string>][] = [
    ['bank-wire', { title: 'Pay the contractor', summary: 'Wire transfer of $500 to the contractor' }],
    ['securities-crypto', { title: 'Rebalance', summary: 'Buy 10 shares of AAPL tomorrow' }],
    ['account-access', { title: 'Check the inbox', summary: 'Log in to her account to check the inbox' }],
    ['credential-change', { title: 'Router fix', summary: 'Reset the password on the router' }],
    ['account-creation', { title: 'Onboard Sam', summary: 'Create an account for the new hire on the wiki' }],
  ];
  expect(HARD_BLOCKS.map((b) => b.id)).toEqual(cases.map(([id]) => id));
  for (const [, input] of cases) {
    const reason = approvalPolicyRefusal(input);
    expect(typeof reason).toBe('string');
    expect(reason!.length).toBeGreaterThan(0);
  }
  // Matching reads every structured field, not just the summary.
  expect(approvalPolicyRefusal({ title: 'Buy 10 shares of AAPL', summary: 'all calm' })).not.toBeNull();
  expect(approvalPolicyRefusal({ title: 'all calm', destination: 'wire transfer desk' })).not.toBeNull();
});

test('ordinary deletes, signs and posts are not blocked', () => {
  for (const input of [
    { action: 'send_email', title: 'Send the reply to Dana', summary: 'Send the draft to dana@example.com' },
    { action: 'post', title: 'Post the launch update', summary: 'Post the release notes to #general' },
    { action: 'delete', title: 'Delete the build output', summary: 'Delete the stale dist folder' },
    { action: 'sign', title: 'Sign the NDA', summary: 'Sign the contractor NDA dated today' },
    { action: 'pay', title: 'Pay the $640 health permit', summary: 'Pay the $640 renewal fee' },
  ]) {
    expect(approvalPolicyRefusal(input)).toBeNull();
  }
  expect(approvalPolicyRefusal({})).toBeNull();
  expect(approvalPolicyRefusal({ title: '', summary: '' })).toBeNull();
});

test('field validation requires recipients, destinations and good urls', () => {
  // A well-formed send passes through intact.
  expect(
    validateApprovalFields({ action: 'send_email', destination: 'mail.google.com', recipients: ['dana@example.com'], url: 'https://mail.google.com/x' }),
  ).toMatchObject({ action: 'send_email', destination: 'mail.google.com', recipients: ['dana@example.com'], url: 'https://mail.google.com/x' });

  // Unknown actions fall back to other rather than throwing.
  expect(validateApprovalFields({ action: 'fax' }).action).toBe('other');
  expect(validateApprovalFields({}).action).toBe('other');

  // Sends need someone to send to; send/post/delete/sign need a where.
  expect(() => validateApprovalFields({ action: 'send_email', destination: 'mail.google.com' })).toThrow('at least one recipient');
  expect(() => validateApprovalFields({ action: 'send_message', recipients: ['Dana'] })).toThrow('destination');
  expect(() => validateApprovalFields({ action: 'post', title: 'hi' })).toThrow('destination');
  expect(() => validateApprovalFields({ action: 'delete' })).toThrow('destination');
  expect(() => validateApprovalFields({ action: 'sign' })).toThrow('destination');

  // Bounds the agent can't talk its way around.
  expect(() => validateApprovalFields({ action: 'post', destination: '#general', url: 'ftp://files/x' })).toThrow('http(s)');
  expect(() => validateApprovalFields({ action: 'post', destination: '#general', url: 'notaurl' })).toThrow('http(s)');
  expect(() => validateApprovalFields({ action: 'post', destination: '#general', recipients: Array.from({ length: 21 }, (_, i) => `u${i}@x.com`) })).toThrow('at most 20');
  expect(() => validateApprovalFields({ action: 'send_email', destination: 'm', recipients: ['a'.repeat(201)] })).toThrow('200 characters');
  expect(() => validateApprovalFields({ action: 'send_email', destination: 'm', recipients: ['a\u0007@x.com'] })).toThrow('control characters');
  expect(() => validateApprovalFields({ action: 'post', destination: '#general', content: 'x'.repeat(8001) })).toThrow('too long');
});
