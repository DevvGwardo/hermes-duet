// Native connectors: the local apps Duet can actually reach from this Mac, what state each is in, and the one command
// the agent can use for each. Nothing here talks to a cloud account: every connector is a CLI or an AppleScript the
// user already has, so "connected" means "installed and willing to answer".
import type { Connector } from '../shared/types';
import { config } from './config';

export interface CalendarEvent {
  title: string;
  start: number;
  end: number;
  location?: string;
}

const CLI: Record<string, string> = {
  reminders: 'remindctl',
  calendar: 'osascript',
  mail: 'osascript',
};

/** The AppleScript that lists the next few hours of events. Tab-separated, ISO dates, one event per line. */
export const CALENDAR_SCRIPT = `set out to ""
set horizon to (current date) + 6 * hours
tell application "Calendar"
  repeat with cal in calendars
    try
      repeat with evt in (every event of cal whose start date is greater than or equal to (current date) and start date is less than or equal to horizon)
        set out to out & (summary of evt) & tab & ((start date of evt) as «class isot» as string) & tab & ((end date of evt) as «class isot» as string) & tab & ((location of evt) as string) & linefeed
      end repeat
    end try
  end repeat
end tell
return out`;

export const MAIL_SCRIPT = `set out to ""
tell application "Mail"
  set msgs to (messages of inbox whose read status is false)
  repeat with m in msgs
    set out to out & (sender of m) & tab & (subject of m) & tab & ((date received of m) as «class isot» as string) & linefeed
  end repeat
end tell
return out`;

/** Parse the tab-separated calendar output into events, skipping anything that doesn't parse cleanly. */
export function parseCalendarOutput(raw: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const [title, start, end, location] = line.split('\t');
    if (!title?.trim() || !start) continue;
    const s = Date.parse(start.trim());
    const e = end ? Date.parse(end.trim()) : s;
    if (!Number.isFinite(s)) continue;
    out.push({ title: title.trim().slice(0, 200), start: s, end: Number.isFinite(e) ? e : s, ...(location?.trim() ? { location: location.trim().slice(0, 120) } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Reminders come as remindctl's JSON when it supports it, else as plain lines ("- title (due)"). */
export function parseReminders(raw: string): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const json = JSON.parse(text);
      const list = Array.isArray(json) ? json : Array.isArray(json?.reminders) ? json.reminders : [];
      return list
        .map((r: any) => String(r?.title ?? r?.name ?? r?.text ?? '').trim())
        .filter(Boolean)
        .slice(0, 50);
    } catch {}
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 50);
}

export interface MailItem {
  from: string;
  subject: string;
  received?: number;
}

export function parseMail(raw: string): MailItem[] {
  const out: MailItem[] = [];
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const [from, subject, when] = line.split('\t');
    if (!subject?.trim()) continue;
    const at = when ? Date.parse(when.trim()) : NaN;
    out.push({ from: (from ?? '').trim().slice(0, 120), subject: subject.trim().slice(0, 200), ...(Number.isFinite(at) ? { received: at } : {}) });
  }
  return out;
}

const STATUS_REASON: Record<Connector['status'], string> = {
  active: 'Working',
  needs_auth: 'Needs permission',
  missing: 'Not installed',
  unsupported: 'Not available on this system',
};

function hasCommand(cmd: string) {
  try {
    return !!Bun.which(cmd);
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[], timeout = 12_000): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([cmd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } finally {
    clearTimeout(timer);
  }
}

/** macOS gates Calendar, Reminders and Mail behind automation permission; -1743 is the "not authorized" code. */
function permissionDenied(err: string): boolean {
  return /-1743|not authori[sz]ed|not permitted|access denied|automation/i.test(err);
}

async function script(scriptText: string): Promise<{ out: string; err: string; code: number }> {
  return run(CLI.calendar, ['-e', scriptText]);
}

export async function calendarEvents(): Promise<CalendarEvent[]> {
  if (process.platform !== 'darwin') return [];
  const r = await script(CALENDAR_SCRIPT);
  if (r.code !== 0) throw new Error(permissionDenied(r.err) ? 'Calendar access is not allowed (System Settings → Privacy & Security → Automation)' : r.err.trim().slice(0, 200) || `osascript exited ${r.code}`);
  return parseCalendarOutput(r.out);
}

export async function unreadMail(): Promise<MailItem[]> {
  if (process.platform !== 'darwin') return [];
  const r = await script(MAIL_SCRIPT);
  if (r.code !== 0) throw new Error(permissionDenied(r.err) ? 'Mail access is not allowed (System Settings → Privacy & Security → Automation)' : r.err.trim().slice(0, 200) || `osascript exited ${r.code}`);
  return parseMail(r.out);
}

/** Today's reminders through remindctl, when it is installed. */
export async function remindersToday(): Promise<string[]> {
  if (!hasCommand(CLI.reminders)) return [];
  const r = await run(CLI.reminders, ['today', '--json']).catch(() => run(CLI.reminders, ['today']));
  if (r.code !== 0) throw new Error(r.err.trim().slice(0, 200) || `remindctl exited ${r.code}`);
  return parseReminders(r.out);
}

async function probe(id: string): Promise<Connector> {
  const unsupported = (name: string, kind: Connector['kind']): Connector => ({
    id,
    name,
    kind,
    status: 'unsupported',
    detail: process.platform === 'darwin' ? STATUS_REASON.unsupported : `${process.platform} has no ${name} bridge`,
    hint: process.platform === 'darwin' ? undefined : 'These bridges are for macOS; on Linux the agent uses your own CLI tools instead.',
  });

  if (id === 'webhook') {
    return { id, name: 'Webhooks', kind: 'webhook', status: 'active', detail: 'Ready for GitHub, Stripe, Zapier or a curl' };
  }
  if (id === 'folder') {
    if (!config.watchDir) return { id, name: 'Watched folder', kind: 'folder', status: 'missing', detail: 'Turned off', hint: 'Set DUET_WATCH_DOWNLOADS=1 or DUET_WATCH_DIR to watch a folder.' };
    const ok = await Bun.file(config.watchDir)
      .exists()
      .catch(() => false);
    return ok
      ? { id, name: 'Watched folder', kind: 'folder', status: 'active', detail: config.watchDir.replace(/^\/Users\/[^/]+/, '~') }
      : { id, name: 'Watched folder', kind: 'folder', status: 'missing', detail: `${config.watchDir} does not exist`, hint: 'Point DUET_WATCH_DIR at a folder that exists.' };
  }
  if (process.platform !== 'darwin') return unsupported(id === 'reminders' ? 'Reminders' : id === 'calendar' ? 'Calendar' : 'Mail', id as Connector['kind']);
  if (id === 'reminders') {
    if (!hasCommand(CLI.reminders)) {
      return {
        id,
        name: 'Reminders',
        kind: 'reminders',
        status: 'missing',
        detail: 'remindctl is not installed',
        hint: 'brew install steipete/tap/remindctl — then the agent can read today\'s reminders itself.',
      };
    }
    try {
      const items = await remindersToday();
      return { id, name: 'Reminders', kind: 'reminders', status: 'active', detail: items.length ? `${items.length} for today` : 'Connected, nothing due today' };
    } catch (e: any) {
      return { id, name: 'Reminders', kind: 'reminders', status: 'needs_auth', detail: String(e?.message ?? e).slice(0, 160), hint: 'Run `remindctl` once in a terminal and allow Reminders access.' };
    }
  }
  if (id === 'calendar') {
    if (!hasCommand(CLI.calendar)) return { id, name: 'Calendar', kind: 'calendar', status: 'missing', detail: 'osascript is missing', hint: 'This is part of macOS; check /usr/bin/osascript.' };
    try {
      const events = await calendarEvents();
      return { id, name: 'Calendar', kind: 'calendar', status: 'active', detail: events.length ? `${events.length} in the next 6 hours` : 'Connected, nothing in the next 6 hours' };
    } catch (e: any) {
      return { id, name: 'Calendar', kind: 'calendar', status: 'needs_auth', detail: String(e?.message ?? e).slice(0, 160), hint: 'System Settings → Privacy & Security → Automation → allow Hermes Duet to control Calendar.' };
    }
  }
  if (id === 'mail') {
    if (!hasCommand(CLI.calendar)) return { id, name: 'Mail', kind: 'mail', status: 'missing', detail: 'osascript is missing', hint: 'This is part of macOS.' };
    try {
      const mail = await unreadMail();
      return { id, name: 'Mail', kind: 'mail', status: 'active', detail: mail.length ? `${mail.length} unread` : 'Connected, inbox is clear' };
    } catch (e: any) {
      return { id, name: 'Mail', kind: 'mail', status: 'needs_auth', detail: String(e?.message ?? e).slice(0, 160), hint: 'System Settings → Privacy & Security → Automation → allow Hermes Duet to control Mail.' };
    }
  }
  throw new Error(`no connector ${id}`);
}

export const CONNECTOR_IDS = ['calendar', 'reminders', 'mail', 'folder', 'webhook'] as const;

/** Status of every connector. Sequential on purpose: three AppleScript permission prompts at once is a bad first run. */
export async function listConnectors(): Promise<Connector[]> {
  const out: Connector[] = [];
  for (const id of CONNECTOR_IDS) {
    try {
      out.push(await probe(id));
    } catch (e: any) {
      out.push({ id, name: id, kind: id as Connector['kind'], status: 'missing', detail: String(e?.message ?? e).slice(0, 160) });
    }
  }
  return out;
}

export function testConnector(id: string): Promise<Connector> {
  return probe(id);
}

/**
 * What the agent is told it can reach, as prompt lines: only the working ones, each with the command to use. A
 * connector that needs permission is left out here and shown in Settings, because the agent can't grant it.
 */
export function connectorBrief(connectors: Connector[]): string {
  const lines: string[] = [];
  for (const c of connectors) {
    if (c.status !== 'active') continue;
    if (c.id === 'calendar') lines.push('- Calendar: read today with osascript (Application "Calendar"); the server also warns you about meetings starting soon.');
    if (c.id === 'reminders') lines.push('- Reminders: `remindctl today --json` lists what is due.');
    if (c.id === 'mail') lines.push('- Mail: read unread mail with osascript (Application "Mail").');
  }
  return lines.join('\n');
}