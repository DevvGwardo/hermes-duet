// The running half of the trigger engine: the webhook token, its rate limit, the folder loop and the meeting clock.
// Everything it decides (what counts as an event, what to say) lives in triggers.ts, which has no database.
import { config } from './config';
import { calendarEvents } from './connectors';
import { inQuietHours } from './clock';
import { kv, settings, triggers } from './db';
import {
  type WatchedFile,
  folderPass,
  meetingsSoon,
  meetingKey,
  folderDue,
  listFolder,
  recentHits,
  webhookAllowed,
  WEBHOOK_WINDOW_MS,
  WEBHOOK_IP_WINDOW_MS,
  webhookIpAllowed,
} from './triggers';
import type { CalendarEvent } from './connectors';

/** The token in a webhook URL. Long, random, and only ever compared in full. */
export function newWebhookToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
}

/** The webhook token, created on first boot so the URL can be shown in Settings before anything calls it. */
export function webhookToken(): string {
  let token = kv.get<string>('webhook_token', '');
  if (!token) {
    token = newWebhookToken();
    kv.set('webhook_token', token);
  }
  return token;
}

const WEBHOOK_RECORD = 'webhook_hits';

export function webhookReady(now = Date.now()): boolean {
  return webhookAllowed(kv.get<number[]>(WEBHOOK_RECORD, []), now);
}

export function recordWebhook(now = Date.now()) {
  kv.set(WEBHOOK_RECORD, [...recentHits(kv.get<number[]>(WEBHOOK_RECORD, []), now, WEBHOOK_WINDOW_MS), now]);
}

const WEBHOOK_IP_RECORD = 'webhook_ip_hits';
export function webhookIpReady(ip: string, now = Date.now()): boolean {
  const all = kv.get<Record<string, number[]>>(WEBHOOK_IP_RECORD, {});
  return webhookIpAllowed(all[ip] ?? [], now);
}
export function recordWebhookIp(ip: string, now = Date.now()) {
  const all = kv.get<Record<string, number[]>>(WEBHOOK_IP_RECORD, {});
  const active: Record<string, number[]> = {};
  // Prune expired IP buckets before capping at 64 so stale scanner entries do not evict live clients.
  for (const [k, hits] of Object.entries(all)) {
    if (k === ip || !Array.isArray(hits)) continue;
    const fresh = recentHits(hits, now, WEBHOOK_IP_WINDOW_MS);
    if (fresh.length) active[k] = fresh;
  }
  const mine = recentHits(Array.isArray(all[ip]) ? all[ip] : [], now, WEBHOOK_IP_WINDOW_MS);
  active[ip] = [...mine, now];
  // Bound the map so a scanner cannot grow it forever, keeping the newest entries at the tail.
  const keys = Object.keys(active).slice(-64);
  kv.set(WEBHOOK_IP_RECORD, Object.fromEntries(keys.map((k) => [k, active[k]])));
}

export interface FolderWatchState {
  previous: WatchedFile[];
  lastFired: number;
}

/** One poll of `dir`. Returns true when new settled files triggered `fire`. */
export async function folderWatchPass(
  state: FolderWatchState,
  dir: string,
  fire: (files: WatchedFile[]) => Promise<void> | void,
  now = Date.now(),
): Promise<boolean> {
  try {
    const current = listFolder(dir);
    // `folderPass` decides what is announced and what stays new; the snapshot is advanced only past settled files.
    const pass = folderPass(state.previous, current, now, {
      due: folderDue(state.lastFired, now),
      quiet: inQuietHours(settings.get(), new Date(now)),
    });
    state.previous = pass.next;
    if (!pass.fire.length) return false;
    state.lastFired = now;
    triggers.save({ id: 'trigger-downloads', kind: 'file_watch', config: { dir }, last_triggered_at: state.lastFired });
    await fire(pass.fire);
    return true;
  } catch (e: any) {
    console.warn('[downloads]', e?.message ?? e);
    return false;
  }
}

/**
 * Watch the Downloads folder. Polling rather than fs.watch: the folder is small, the interval is 15 seconds, and a
 * poll cannot miss a rename or wedge itself the way an FSEvent stream can after the Mac sleeps.
 */
export function startFolderWatch(fire: (files: WatchedFile[]) => Promise<void>) {
  if (!config.watchDir) return;
  // The first pass establishes what was already there: opening Duet must not announce yesterday's downloads.
  const state: FolderWatchState = { previous: listFolder(config.watchDir), lastFired: Date.now() };
  setInterval(() => {
    void folderWatchPass(state, config.watchDir, fire);
  }, 15_000);
}

/** Meetings already announced, so a tick every minute doesn't repeat itself. */
const announcedMeetings = new Set<string>();

export function meetingPrepEnabled(now = Date.now()): boolean {
  return config.meetingLeadMinutes > 0 && !inQuietHours(settings.get(), new Date(now));
}

/**
 * Meetings that just entered the lead window, marked as announced. Announcements for events that have started are
 * dropped, so the set tracks only the near future.
 */
export function meetingsToPrep(events: CalendarEvent[], now = Date.now()): CalendarEvent[] {
  // The key starts with the event's start time. Pruning by that, not by what the current calendar read contains,
  // also forgets an event that was cancelled or moved before it started, so the set cannot grow for the process life.
  for (const key of announcedMeetings) {
    const start = Number(key.slice(0, key.indexOf('|')));
    if (!Number.isFinite(start) || start <= now) announcedMeetings.delete(key);
  }
  const due = meetingsSoon(events, now, config.meetingLeadMinutes * 60_000, announcedMeetings);
  for (const e of due) announcedMeetings.add(meetingKey(e));
  return due;
}

/** One pass of the meeting clock. Returns how many meetings it woke the agent for. */
export async function checkMeetings(
  fire: (e: CalendarEvent, now: number) => void,
  now = Date.now(),
  readEvents: () => Promise<CalendarEvent[]> = calendarEvents,
): Promise<number> {
  if (!meetingPrepEnabled(now)) return 0;
  const events = await readEvents();
  const due = meetingsToPrep(events, now);
  for (const e of due) fire(e, now);
  return due.length;
}