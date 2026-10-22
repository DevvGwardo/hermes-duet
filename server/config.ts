import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

// Optional KEY=VALUE file next to the repo; real env vars win.
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const env = process.env;

export const config = {
  root,
  dataDir: env.DUET_DATA_DIR ?? join(root, 'data'),
  webDir: join(root, 'web', 'dist'),
  host: env.DUET_HOST ?? '127.0.0.1',
  port: Number(env.DUET_PORT ?? 7456),
  /** Loopback-only listener for the MCP shim and the CLI. Never point the tunnel here. */
  internalPort: Number(env.DUET_INTERNAL_PORT ?? 7457),
  publicUrl: env.DUET_PUBLIC_URL ?? '',
  hermesUrl: (env.DUET_HERMES_URL ?? 'http://127.0.0.1:8642').replace(/\/$/, ''),
  hermesKey: env.DUET_HERMES_KEY ?? env.API_SERVER_KEY ?? '',
  hermesHome: env.HERMES_HOME ?? join(homedir(), '.hermes'),
  hermesModel: env.DUET_HERMES_MODEL ?? 'hermes-agent',
  /** A run that sends no event for this long (and isn't waiting on the user) is stopped as hung (runHung). */
  runTimeoutMs: Number(env.DUET_RUN_TIMEOUT_MS ?? 45 * 60_000),
  maxBackground: Number(env.DUET_MAX_BACKGROUND ?? 2),
  userName: env.DUET_USER_NAME ?? '',
  /** Markdown list of where this user's context lives (task lists, notes, inboxes). Gitignored by default. */
  contextFile: env.DUET_CONTEXT_FILE ?? join(root, 'context.local.md'),
  /** Hermes memory scope (X-Hermes-Session-Key). Sessions stay bound to the scope they were created with. */
  sessionScope: env.DUET_SESSION_SCOPE ?? 'hermes-duet',
  /** Extra device-cookie name to accept, for installs that paired under an older cookie name. */
  legacyCookie: env.DUET_LEGACY_COOKIE ?? '',
};
