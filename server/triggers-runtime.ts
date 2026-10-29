// The running half of the trigger engine: the webhook token, its rate limit, the folder loop and the meeting clock.
// Everything it decides (what counts as an event, what to say) lives in triggers.ts, which has no database.
import { config } from './config';
import { calendarEvents } from './connectors';
import { inQuietHours } from './clock';
import { kv, settings, triggers } from './db';
import {
  type WatchedFile,
  meetingsSoon,
  meetingKey,
  newDownloads,
  folderDue,
  listFolder,
  recentHits,
  webhookAllowed,
  WEBHOOK_WINDOW_MS,
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

/**
 * Watch the Downloads folder. Polling rather than fs.watch: the folder is small, the interval is 15 seconds, and a
 * poll cannot miss a rename or wedge itself the way an FSEvent stream can after the Mac sleeps.
 */
export function startFolderWatch(fire: (files: WatchedFile[]) => Promise<void>) {
  if (!config.watchDir) return;
  let previous = listFolder(config.watchDir);
  // The first pass establishes what was already there: opening Duet must not announce yesterday's downloads.
  let lastFired = Date.now();
  setInterval(async () => {
    try {
      const current = listFolder(config.watchDir);
      const fresh = newDownloads(previous, current, Date.now());
      previous = current;
      if (!fresh.length || !folderDue(lastFired, Date.now())) return;
      if (inQuietHours(settings.get())) return;
      lastFired = Date.now();
      triggers.save({ id: 'trigger-downloads', kind: 'file_watch', config: { dir: config.watchDir }, last_triggered_at: lastFired });
      await fire(fresh);
    } catch (e: any) {
      console.warn('[downloads]', e?.message ?? e);
    }
  }, 15_000);
}

/** Meetings already announced, so a tick every minute doesn't repeat itself. */
const announcedMeetings = new Set<string>();

export function meetingPrepEnabled(): boolean {
  return config.meetingLeadMinutes > 0 && !inQuietHours(settings.get());
}

/**
 * Meetings that just entered the lead window, marked as announced. Announcements for events that have started are
 * dropped, so the set tracks only the near future.
 */
export function meetingsToPrep(events: CalendarEvent[], now = Date.now()): CalendarEvent[] {
  for (const e of events) if (e.start <= now) announcedMeetings.delete(meetingKey(e));
  const due = meetingsSoon(events, now, config.meetingLeadMinutes * 60_000, announcedMeetings);
  for (const e of due) announcedMeetings.add(meetingKey(e));
  return due;
}

/** One pass of the meeting clock. Returns how many meetings it woke the agent for. */
export async function checkMeetings(fire: (e: CalendarEvent, now: number) => void, now = Date.now()): Promise<number> {
  if (!meetingPrepEnabled()) return 0;
  const events = await calendarEvents();
  const due = meetingsToPrep(events, now);
  for (const e of due) fire(e, now);
  return due.length;
}