import { describe, expect, test } from 'bun:test';
import { commandFor, parseLogin, safeDomain, vaultPlan } from './vault';

const has = (present: string[]) => (cmd: string) => present.includes(cmd);

describe('parseLogin', () => {
  test('reads Bitwarden item JSON', () => {
    expect(parseLogin({ login: { username: 'me@example.com', password: 'hunter2' } })).toEqual({ username: 'me@example.com', password: 'hunter2' });
  });

  test('reads a 1Password fields array keyed by label or id', () => {
    expect(
      parseLogin({
        fields: [
          { id: 'username', label: 'username', value: 'me@example.com' },
          { id: 'password', label: 'password', value: 'hunter2' },
        ],
      }),
    ).toEqual({ username: 'me@example.com', password: 'hunter2' });
    expect(parseLogin([{ label: 'Email', value: 'me@example.com' }, { label: 'Password', value: 'hunter2' }])).toEqual({
      username: 'me@example.com',
      password: 'hunter2',
    });
  });

  test('reads a flat object, which is what a small script prints', () => {
    expect(parseLogin({ username: 'me', password: 'pw' })).toEqual({ username: 'me', password: 'pw' });
  });

  test('a login without a password is not a login', () => {
    expect(parseLogin({ username: 'me' })).toBeNull();
    expect(parseLogin({ fields: [{ id: 'username', value: 'me' }] })).toBeNull();
    expect(parseLogin(null)).toBeNull();
    expect(parseLogin('string')).toBeNull();
    expect(parseLogin({})).toBeNull();
  });

  test('a password-only item still fills the password', () => {
    expect(parseLogin({ fields: [{ id: 'password', value: 'pw' }] })).toEqual({ username: '', password: 'pw' });
  });
});

describe('safeDomain', () => {
  test('takes a domain out of whatever the page URL is', () => {
    expect(safeDomain('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(safeDomain('accounts.google.com:443/signin')).toBe('accounts.google.com');
    expect(safeDomain('EXAMPLE.com')).toBe('example.com');
  });

  test('refuses anything that is not a plain domain, so nothing becomes a flag', () => {
    expect(safeDomain('--help')).toBeNull();
    expect(safeDomain('-n')).toBeNull();
    expect(safeDomain('localhost')).toBeNull();
    expect(safeDomain('')).toBeNull();
    expect(safeDomain('exa mple.com')).toBeNull();
    expect(safeDomain('example.com; rm -rf /')).toBeNull();
    expect(safeDomain('../../etc/passwd')).toBeNull(); // no dot in the last segment: not a domain
  });
});

describe('commandFor', () => {
  test('fills the domain into the template and nothing else', () => {
    expect(commandFor('op item get {domain} --format json', 'example.com')).toEqual({ cmd: 'op', args: ['item', 'get', 'example.com', '--format', 'json'] });
  });

  test('a template without the placeholder simply has no domain', () => {
    expect(commandFor('bw get item', 'example.com')).toEqual({ cmd: 'bw', args: ['get', 'item'] });
  });
});

describe('vaultPlan', () => {
  test('reports what is installed and how to get the rest', () => {
    const plan = vaultPlan({}, has(['op']));
    expect(plan.map((p) => [p.id, p.installed])).toEqual([
      ['1password', true],
      ['bitwarden', false],
    ]);
    expect(plan[1].hint).toMatch(/Bitwarden CLI/);
  });

  test('honors custom command templates', () => {
    const plan = vaultPlan({ DUET_OP_CMD: 'myvault get {domain}' }, has(['myvault']));
    expect(plan[0].cmd).toBe('myvault');
    expect(plan[0].installed).toBe(true);
  });
});

describe('commandFor', () => {
  test('substitutes only the domain, and never as a flag or an extra argv word', () => {
    expect(commandFor('op item get {domain} --format json', 'mail.example.com')).toEqual({
      cmd: 'op',
      args: ['item', 'get', 'mail.example.com', '--format', 'json'],
    });
    // A domain can only ever be one argument: safeDomain has already refused anything with a space or a slash.
    expect(commandFor('bw get item {domain} --raw', 'example.com')).toEqual({ cmd: 'bw', args: ['get', 'item', 'example.com', '--raw'] });
    expect(safeDomain('example.com; rm -rf /')).toBeNull();
    expect(safeDomain('--help')).toBeNull();
    expect(safeDomain('http://mail.example.com/inbox')).toBe('mail.example.com');
  });
});
