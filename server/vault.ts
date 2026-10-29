// Password vaults for the live browser. The point is not to store credentials: it is to stop the user typing a long
// password on a phone keyboard into a streamed canvas while the agent waits. A local CLI (1Password `op`, Bitwarden
// `bw`) hands the login to the server, which types it into Chrome as trusted input and forgets it.
import { CARD_TTL_MS } from './payments';

type Env = Record<string, string | undefined>;

export type VaultId = '1password' | 'bitwarden';

export interface VaultStatus {
  id: VaultId;
  name: string;
  /** The CLI is installed, so autofill is at least possible. */
  installed: boolean;
  /** Signed in (and unlocked) right now, so autofill will work without a terminal step. */
  ready: boolean;
  detail: string;
  hint?: string;
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Read a login out of whichever JSON shape the vault CLI printed: 1Password items carry a `fields` array keyed by
 * label or id, Bitwarden items nest it under `login`, and a small script may just print `{username, password}`.
 * Pure, so the parsers can be tested without running either CLI.
 */
export function parseLogin(json: any): { username: string; password: string } | null {
  if (!json || typeof json !== 'object') return null;
  const flat = { username: text(json.username), password: text(json.password) };
  if (flat.password) return flat;
  const login = json.login;
  if (login && typeof login === 'object' && text(login.password)) return { username: text(login.username), password: text(login.password) };
  if (Array.isArray(json.fields)) {
    let username = '';
    let password = '';
    for (const f of json.fields) {
      const key = String(f?.id ?? f?.label ?? f?.name ?? '').toLowerCase();
      const value = text(f?.value);
      if (!value) continue;
      if (!username && /user|email|login/.test(key)) username = value;
      if (!password && /pass/.test(key)) password = value;
    }
    if (password) return { username, password };
  }
  // 1Password's `--fields label=username,label=password` shape: [{ label, value }]
  if (Array.isArray(json)) {
    let username = '';
    let password = '';
    for (const f of json) {
      const key = String(f?.id ?? f?.label ?? f?.name ?? '').toLowerCase();
      const value = text(f?.value ?? f?.content);
      if (!value) continue;
      if (!username && /user|email|login/.test(key)) username = value;
      if (!password && /pass/.test(key)) password = value;
    }
    if (password) return { username, password };
  }
  return null;
}

/** Which vaults are installed, from the outside in: what is on PATH decides everything else. */
export function vaultPlan(env: Env, has: (cmd: string) => boolean): { id: VaultId; name: string; cmd: string; installed: boolean; hint: string }[] {
  return [
    {
      id: '1password',
      name: '1Password',
      cmd: (env.DUET_OP_CMD ?? 'op item get {domain} --format json').split(/\s+/)[0],
      installed: has((env.DUET_OP_CMD ?? 'op item get {domain} --format json').split(/\s+/)[0]),
      hint: 'Install the 1Password CLI (brew install 1password-cli) and turn on "Connect with 1Password CLI" in the app.',
    },
    {
      id: 'bitwarden',
      name: 'Bitwarden',
      cmd: (env.DUET_BW_CMD ?? 'bw get item {domain} --raw').split(/\s+/)[0],
      installed: has((env.DUET_BW_CMD ?? 'bw get item {domain} --raw').split(/\s+/)[0]),
      hint: 'Install the Bitwarden CLI (brew install bitwarden-cli) and run `bw unlock`; set BW_SESSION for the server.',
    },
  ];
}

/** Fill `{domain}` in a command template; nothing else from the URL reaches the argv. */
export function commandFor(template: string, domain: string): { cmd: string; args: string[] } {
  const [cmd, ...args] = template.split(/\s+/);
  return { cmd, args: args.map((a) => a.replaceAll('{domain}', domain)) };
}

/** A domain the vault can be asked about: no scheme, no path, no quotes, no flags. */
export function safeDomain(raw: unknown): string | null {
  const host = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '');
  // Every label needs a real character at each end, so "..", "-x.com" and "x-.com" are not domains.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || host.length > 253) return null;
  return host;
}

function hasCommand(cmd: string) {
  try {
    return !!Bun.which(cmd);
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[], env: Env = {}): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(env as Record<string, string>) },
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } finally {
    clearTimeout(timer);
  }
}

/** Status of both vaults for the settings sheet: installed? signed in? */
export async function vaults(): Promise<VaultStatus[]> {
  const plan = vaultPlan(process.env, hasCommand);
  const out: VaultStatus[] = [];
  for (const p of plan) {
    if (!p.installed) {
      out.push({ id: p.id, name: p.name, installed: false, ready: false, detail: 'Not installed', hint: p.hint });
      continue;
    }
    if (p.id === '1password') {
      const who = await run('op', ['whoami']).catch(() => ({ out: '', err: '', code: 1 }));
      const ready = who.code === 0 && !!who.out.trim();
      out.push({ id: p.id, name: p.name, installed: true, ready, detail: ready ? `Signed in as ${who.out.trim().slice(0, 60)}` : 'Installed, not signed in', hint: ready ? undefined : 'Run `op signin` on the Mac.' });
    } else {
      const st = await run('bw', ['status']).catch(() => ({ out: '', err: '', code: 1 }));
      let status = '';
      try {
        status = String(JSON.parse(st.out)?.status ?? '');
      } catch {}
      const ready = status === 'unlocked';
      out.push({
        id: p.id,
        name: p.name,
        installed: true,
        ready,
        detail: ready ? 'Unlocked' : status ? `Vault is ${status}` : 'Installed, not unlocked',
        hint: ready ? undefined : 'Run `bw unlock` on the Mac and put the session key in BW_SESSION.',
      });
    }
  }
  return out;
}

/**
 * Look up one login. Values are returned to the caller and never written anywhere; the caller types them into Chrome
 * and drops them. `which` pins a vault when the user asked for one.
 */
export async function readLogin(domain: string, which?: VaultId): Promise<{ vault: VaultId; username: string; password: string }> {
  const host = safeDomain(domain);
  if (!host) throw new Error('that page has no domain to look a login up by');
  const plan = vaultPlan(process.env, hasCommand).filter((p) => p.installed && (!which || p.id === which));
  if (!plan.length) throw new Error(which ? `${which} is not installed on this Mac` : 'No password vault CLI is installed (1Password `op` or Bitwarden `bw`).');
  const errors: string[] = [];
  for (const p of plan) {
    const template = p.id === '1password' ? (process.env.DUET_OP_CMD ?? 'op item get {domain} --format json') : (process.env.DUET_BW_CMD ?? 'bw get item {domain} --raw');
    const { cmd, args } = commandFor(template, host);
    const r = await run(cmd, args, p.id === 'bitwarden' && process.env.BW_SESSION ? { BW_SESSION: process.env.BW_SESSION } : {}).catch((e) => ({ out: '', err: String(e?.message ?? e), code: 1 }));
    if (r.code !== 0) {
      errors.push(`${p.name}: ${(r.err || r.out).trim().split('\n')[0]?.slice(0, 120) || `exit ${r.code}`}`);
      continue;
    }
    let json: any = null;
    try {
      json = JSON.parse(r.out);
    } catch {}
    const login = parseLogin(json);
    if (login) return { vault: p.id, ...login };
    errors.push(`${p.name}: no login for ${host}`);
  }
  throw new Error(`No login found for ${host}. ${errors.join(' · ')}`);
}

/** The card is typed in immediately; nothing here waits around. Re-exported so callers keep one import. */
export const cardTtlMs = CARD_TTL_MS;