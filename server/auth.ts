import { config } from './config';
import { db, newId } from './db';

const COOKIE = 'duet_device';
const PAIR_TTL_MS = 10 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(buf).toString('hex');
}

function randomToken(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export function createPairCode(): { code: string; expires_at: number } {
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => ALPHABET[b % ALPHABET.length]).join('');
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expires_at = Date.now() + PAIR_TTL_MS;
  db.query('DELETE FROM pair_codes WHERE expires_at < ?').run(Date.now());
  db.query('INSERT INTO pair_codes(code, expires_at) VALUES (?, ?)').run(code, expires_at);
  return { code, expires_at };
}

// Global brute-force brake: a handful of wrong codes locks pairing for a while.
let failures: number[] = [];

export async function redeemPairCode(input: string, deviceName: string): Promise<string | null> {
  const now = Date.now();
  failures = failures.filter((t) => now - t < PAIR_TTL_MS);
  if (failures.length >= 8) return null;
  const norm = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = `${norm.slice(0, 4)}-${norm.slice(4, 8)}`;
  const row = db.query<{ expires_at: number }, [string]>('SELECT expires_at FROM pair_codes WHERE code = ?').get(code);
  if (!row || row.expires_at < now) {
    failures.push(now);
    return null;
  }
  db.query('DELETE FROM pair_codes WHERE code = ?').run(code);
  const token = randomToken();
  db.query('INSERT INTO devices(id, token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').run(
    newId(),
    await sha256(token),
    deviceName.slice(0, 120),
    now,
    now,
  );
  return token;
}

export async function deviceFor(req: Request): Promise<string | null> {
  const token = readCookie(req, COOKIE) ?? (config.legacyCookie ? readCookie(req, config.legacyCookie) : null);
  if (!token) return null;
  const hash = await sha256(token);
  const row = db.query<{ id: string; last_seen: number }, [string]>('SELECT id, last_seen FROM devices WHERE token_hash = ?').get(hash);
  if (!row) return null;
  if (Date.now() - row.last_seen > 3600_000) db.query('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), row.id);
  return row.id;
}

export function deviceCookie(token: string, secure: boolean) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${secure ? '; Secure' : ''}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function isHttps(req: Request) {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https' || !!req.headers.get('cf-visitor')?.includes('https');
}

/** Same-origin check for state-changing requests (defense in depth on top of SameSite + JSON bodies). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser clients and same-origin GET-ish navigations
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function internalToken(): string {
  const row = db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?').get('internal_token');
  if (row) return JSON.parse(row.value);
  const t = randomToken();
  db.query('INSERT INTO kv(key, value) VALUES (?, ?)').run('internal_token', JSON.stringify(t));
  return t;
}
