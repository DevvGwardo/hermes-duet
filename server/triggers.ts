// Event-driven proactivity: things that happen to the user rather than times on a clock. A webhook from GitHub or
// Stripe, a receipt landing in Downloads, a meeting starting in fifteen minutes.
//
// This module is pure: what counts as an event, what the agent is told, and when to stay quiet. The loops, the token
// and the rate limits live in triggers-runtime.ts, so the rules here can be tested without a database or a folder.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import { config } from './config';
import type { CalendarEvent } from './connectors';

const MAX_EVENT_TEXT = 2000;

/**
 * Compare the token from a URL with the one in the database without leaking where they diverge. The length check
 * comes first, which is the one thing timing can reveal here and is not worth hiding.
 */
export function webhookMatches(expected: string, provided: string): boolean {
  const a = String(expected ?? '');
  const b = String(provided ?? '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The queued line for a webhook: what arrived, from where, and as much payload as is useful. */
export function webhookPrompt(kind: string, payload: unknown, now = Date.now(), tz?: string): string {
  const name =
    String(kind || 'webhook')
      // Keep word characters and dots, then trim what is left of any path-like leading dots ("../../etc" -> "etc").
      .replace(/[^\w.-]/g, '')
      .replace(/^[.-]+/, '')
      .replace(/\.{2,}/g, '.')
      .slice(0, 40) || 'webhook';
  let body = '';
  if (typeof payload === 'string') body = payload;
  else {
    try {
      body = JSON.stringify(payload, null, 2) ?? '';
    } catch {
      body = String(payload);
    }
  }
  const trimmed = body.trim().slice(0, MAX_EVENT_TEXT);
  const at = new Date(now).toLocaleString('en-US', { timeZone: tz });
  return `[${name}] An external event arrived through the webhook: ${at}.\n\n${trimmed || '(no payload)'}\n\nDecide whether this needs the user: if it does, say what and why in one short line and, where a next step is obvious, prepare it. If it doesn't, say nothing more than that you saw it. Don't act on anything outward-facing without request_approval, and don't spend money without request_payment.`;
}

/** Files that are worth interrupting for. Downloads also holds installers and disk images; those can wait. */
const INTERESTING = new Set(['.pdf', '.csv', '.xlsx', '.docx', '.txt', '.png', '.jpg', '.jpeg', '.heic', '.md', '.eml']);
const IN_FLIGHT = /\.(crdownload|download|part|partial|tmp|opdownload)$/i;

export function watchableFile(name: string): boolean {
  if (!name || name.startsWith('.')) return false;
  if (IN_FLIGHT.test(name)) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && INTERESTING.has(name.slice(dot).toLowerCase());
}

export interface WatchedFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

/** Read the watched folder. Unreadable folders come back empty rather than throwing on a background timer. */
export function listFolder(dir: string): WatchedFile[] {
  if (!dir || !existsSync(dir)) return [];
  const out: WatchedFile[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!watchableFile(name)) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ name, path, size: st.size, mtime: st.mtimeMs });
    } catch {}
  }
  return out;
}

/** How long a file must sit unchanged before it counts as finished, so a download in pieces isn't read half-written. */
export const SETTLE_MS = 20_000;

const fileKey = (f: WatchedFile) => `${f.name}:${f.size}:${f.mtime}`;

/**
 * New files since the previous snapshot. A file that changed in the last `settleMs` is still being written (a bank
 * statement that downloads in pieces), so it is left for the next pass instead of being handed to the agent half-read.
 */
export function newDownloads(previous: WatchedFile[], current: WatchedFile[], now: number, settleMs = SETTLE_MS): WatchedFile[] {
  const seen = new Set(previous.map(fileKey));
  return current.filter((f) => !seen.has(fileKey(f)) && now - f.mtime >= settleMs);
}

export interface FolderPass {
  /** Files to hand to the agent now. */
  fire: WatchedFile[];
  /** The snapshot the next pass compares against: only files whose fate is already settled. */
  next: WatchedFile[];
}

/**
 * One watched-folder poll pass. Only advances `next` past files that have been settled (fired or dropped for
 * quiet hours); files that are too fresh to announce or held by gap throttling stay out of `next` for re-checking.
 */
export function folderPass(
  previous: WatchedFile[],
  current: WatchedFile[],
  now: number,
  opts: { due: boolean; quiet: boolean; settleMs?: number },
): FolderPass {
  // Quiet hours drop the batch rather than holding it: a receipt downloaded at 2am is not news at 7am, and the
  // morning brief already reads what is in the folder.
  if (opts.quiet) return { fire: [], next: current };
  const ready = newDownloads(previous, current, now, opts.settleMs);
  if (!opts.due) {
    // Nothing goes out this pass: keep the files we already knew about, and leave the new ones new.
    const known = new Set(previous.map(fileKey));
    return { fire: [], next: current.filter((f) => known.has(fileKey(f))) };
  }
  const settled = new Set([...previous.map(fileKey), ...ready.map(fileKey)]);
  return { fire: ready, next: current.filter((f) => settled.has(fileKey(f))) };
}

/** The queued line for one batch of new files. */
export function downloadsPrompt(files: WatchedFile[], dir = config.watchDir): string {
  const lines = files.map((f) => `- ${f.path} (${Math.max(1, Math.round(f.size / 1024))} KB)`);
  return `[downloads] ${files.length === 1 ? 'A new file landed' : `${files.length} new files landed`} in ${basename(dir)}:\n${lines.join('\n')}\n\nLook at ${files.length === 1 ? 'it' : 'them'} if that seems useful (a receipt, a statement, a ticket) and file or summarize what matters. If it needs nothing, say so in one short line.`;
}

/** Meetings starting inside the lead window, ignoring ones already announced. */
export function meetingsSoon(events: CalendarEvent[], now: number, leadMs: number, announced: Set<string>): CalendarEvent[] {
  if (!(leadMs > 0)) return [];
  return events.filter((e) => e.start > now && e.start - now <= leadMs && !announced.has(meetingKey(e))).sort((a, b) => a.start - b.start);
}

export const meetingKey = (e: CalendarEvent) => `${e.start}|${e.title.toLowerCase()}`;

export function meetingPrompt(e: CalendarEvent, now: number, tz: string): string {
  const minutes = Math.max(1, Math.round((e.start - now) / 60_000));
  const at = new Date(e.start).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `[calendar] "${e.title}" starts at ${at}, in ${minutes} minute${minutes === 1 ? '' : 's'}${e.location ? ` (${e.location})` : ''}.\n\nPost a short meeting-prep card: who it is probably with, anything from email or notes that needs settling first, and one line of talking points. If there is nothing useful to say, reply with one line and don't post a card.`;
}

/** One folder warning per minute is plenty; a big download can otherwise wake the agent several times. */
export const FOLDER_GAP_MS = 60_000;
/** Webhooks are cheap to send, so this is only a runaway guard. */
export const WEBHOOK_WINDOW_MS = 10 * 60_000;
export const WEBHOOK_MAX = 60;
/** Per source the webhooks are throttled harder than globally: an unpaired token guess must decay quickly. */
export const WEBHOOK_IP_WINDOW_MS = 60_000;
export const WEBHOOK_IP_MAX = 30;

/** Client for a request: X-Forwarded-For is only trusted when the direct socket peer is loopback. */
export function inboundIp(req: Request, fallback = 'unknown'): string {
  const isLoopback = fallback === '127.0.0.1' || fallback === '::1' || fallback.toLowerCase() === '::ffff:127.0.0.1';
  if (!isLoopback) return fallback;
  const raw = String(req.headers.get('x-forwarded-for') ?? '')
    .split(',')[0]
    ?.trim();
  return raw && isIP(raw) !== 0 ? raw : fallback;
}

export function folderDue(lastAt: number, now: number, gap = FOLDER_GAP_MS): boolean {
  return now - lastAt >= gap;
}

/** How many hits landed inside the window, given the timestamps recorded so far. */
export function recentHits(hits: number[], now: number, window = WEBHOOK_WINDOW_MS): number[] {
  return hits.filter((t) => now - t < window);
}

export function webhookAllowed(hits: number[], now: number): boolean {
  return recentHits(hits, now).length < WEBHOOK_MAX;
}

/** Per-IP throttle for the unauthenticated webhook route. Counts only that source's attempts in the window. */
export function webhookIpAllowed(hits: number[], now: number): boolean {
  return recentHits(hits, now, WEBHOOK_IP_WINDOW_MS).length < WEBHOOK_IP_MAX;
}