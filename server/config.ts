import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

/**
 * A value as dotenv reads it: a `#` at the start of the value or after whitespace begins a comment, unless it is
 * inside quotes; surrounding quotes are dropped. Without this, `DUET_PORT=7456  # the app` became the string
 * "7456  # the app", and every Number() below is NaN.
 */
export function parseEnvValue(raw: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      out += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      out += c;
    } else if (c === '#' && (i === 0 || /\s/.test(raw[i - 1]))) {
      break;
    } else {
      out += c;
    }
  }
  return out.trim().replace(/^(['"])(.*)\1$/, '$2');
}

// Optional KEY=VALUE file next to the repo; real env vars win.
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = parseEnvValue(m[2]);
  }
}

const env = process.env;

/**
 * A positive number from the environment. A typo must not silently disable a limit: `DUET_RUN_TIMEOUT_MS=abc` is
 * NaN, and `elapsed >= NaN` is always false, so the hung-run watchdog would never fire.
 */
function positiveNumber(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[config] ${name}=${JSON.stringify(raw)} is not a positive number; using ${fallback}`);
    return fallback;
  }
  return n;
}

export const config = {
  root,
  dataDir: env.DUET_DATA_DIR ?? join(root, 'data'),
  webDir: join(root, 'web', 'dist'),
  host: env.DUET_HOST ?? '127.0.0.1',
  port: positiveNumber('DUET_PORT', 7456),
  /** Loopback-only listener for the MCP shim and the CLI. Never point the tunnel here. */
  internalPort: positiveNumber('DUET_INTERNAL_PORT', 7457),
  publicUrl: env.DUET_PUBLIC_URL ?? '',
  hermesUrl: (env.DUET_HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/$/, ''),
  hermesKey: env.DUET_HERMES_KEY ?? env.API_SERVER_KEY ?? '',
  hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
  hermesModel: env.DUET_HERMES_MODEL ?? 'hermes-agent',
  /** A run that sends no event for this long (and isn't waiting on the user) is stopped as hung (runHung). */
  runTimeoutMs: positiveNumber('DUET_RUN_TIMEOUT_MS', 45 * 60_000),
  maxBackground: positiveNumber('DUET_MAX_BACKGROUND', 2),
  /**
   * Hard ceiling for one `request_payment`, in cents. DUET_MAX_TRANSACTION_LIMIT is written in dollars ($500 by
   * default) because that is how a spending limit is thought about; DUET_MAX_TRANSACTION_LIMIT_CENTS is the exact
   * form when a cent matters.
   */
  maxTransactionCents: (() => {
    const cents = Number(env.DUET_MAX_TRANSACTION_LIMIT_CENTS ?? '');
    if (Number.isFinite(cents) && cents > 0) return Math.floor(cents);
    return Math.round(positiveNumber('DUET_MAX_TRANSACTION_LIMIT', 500) * 100);
  })(),
  /** Watched folder for receipts and statements; '' turns the folder trigger off (DUET_WATCH_DOWNLOADS=0). */
  watchDir: env.DUET_WATCH_DOWNLOADS === '0' ? '' : env.DUET_WATCH_DIR || join(homedir(), 'Downloads'),
  /** A calendar event this many minutes away is worth a meeting-prep nudge. */
  meetingLeadMinutes: positiveNumber('DUET_MEETING_LEAD_MIN', 15),
  userName: env.DUET_USER_NAME ?? '',
  /** Markdown list of where this user's context lives (task lists, notes, inboxes). Gitignored by default. */
  contextFile: env.DUET_CONTEXT_FILE ?? join(root, 'context.local.md'),
  /** Hermes memory scope (X-Hermes-Session-Key). Sessions stay bound to the scope they were created with. */
  sessionScope: env.DUET_SESSION_SCOPE ?? 'hermes-duet',
  /** Extra device-cookie name to accept, for installs that paired under an older cookie name. */
  legacyCookie: env.DUET_LEGACY_COOKIE ?? '',
};
