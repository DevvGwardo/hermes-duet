import { describe, expect, test } from 'bun:test';
import type { CalendarEvent } from './connectors';
import {
  downloadsPrompt,
  folderDue,
  folderPass,
  inboundIp,
  meetingKey,
  meetingPrompt,
  meetingsSoon,
  newDownloads,
  recentHits,
  watchableFile,
  webhookAllowed,
  webhookIpAllowed,
  webhookMatches,
  webhookPrompt,
  type WatchedFile,
} from './triggers';

const file = (name: string, size = 100, mtime = 1_000_000): WatchedFile => ({ name, size, mtime, path: `/Users/me/Downloads/${name}` });
const event = (title: string, start: number, end = start + 1_800_000): CalendarEvent => ({ title, start, end });

describe('webhookMatches', () => {
  const token = 'abcdefghijklmnopqrstuvwx';

  test('only the exact token passes', () => {
    expect(webhookMatches(token, token)).toBe(true);
    expect(webhookMatches(token, `${token}x`)).toBe(false);
    expect(webhookMatches(token, token.slice(0, -1))).toBe(false);
    expect(webhookMatches(token, token.toUpperCase())).toBe(false);
  });

  test('an empty token on either side never matches', () => {
    expect(webhookMatches('', '')).toBe(false);
    expect(webhookMatches(token, '')).toBe(false);
    expect(webhookMatches('', token)).toBe(false);
  });
});

describe('webhookPrompt', () => {
  test('names the event and carries a readable payload', () => {
    const p = webhookPrompt('github', { action: 'opened', pull_request: { number: 7 } }, Date.UTC(2026, 9, 22, 12), 'UTC');
    expect(p).toContain('[github]');
    expect(p).toContain('"action": "opened"');
    expect(p).toContain('request_approval');
  });

  test('accepts a plain-text payload and bounds it', () => {
    expect(webhookPrompt('stripe', 'payment succeeded')).toContain('payment succeeded');
    expect(webhookPrompt('x', 'y'.repeat(5000)).length).toBeLessThan(2500);
  });

  test('sanitizes the event name and survives a payload that will not serialize', () => {
    expect(webhookPrompt('../../etc', null)).toContain('[etc]');
    const circular: any = {};
    circular.self = circular;
    expect(() => webhookPrompt('x', circular)).not.toThrow();
  });

  test('an empty payload is still a message', () => {
    expect(webhookPrompt('', '')).toContain('(no payload)');
    expect(webhookPrompt('', '')).toContain('[webhook]');
  });
});

describe('watchableFile', () => {
  test('takes the documents a person downloads on purpose', () => {
    for (const name of ['receipt.pdf', 'statement.CSV', 'scan.png', 'notes.md']) expect(watchableFile(name)).toBe(true);
  });

  test('ignores installers, hidden files and things still downloading', () => {
    for (const name of ['installer.dmg', 'archive.zip', '.DS_Store', 'receipt.pdf.crdownload', 'x.part', 'no-extension']) {
      expect(watchableFile(name)).toBe(false);
    }
  });
});

describe('newDownloads', () => {
  const now = 2_000_000;

  test('reports files that appeared and are settled', () => {
    const before = [file('old.pdf', 10, now - 600_000)];
    const after = [...before, file('new.pdf', 20, now - 30_000)];
    expect(newDownloads(before, after, now).map((f) => f.name)).toEqual(['new.pdf']);
  });

  test('waits for a file that is still being written', () => {
    const after = [file('growing.pdf', 20, now - 2_000)];
    expect(newDownloads([], after, now)).toEqual([]);
  });

  test('a file that grew is new again, because its size changed', () => {
    const before = [file('doc.pdf', 10, now - 600_000)];
    const after = [file('doc.pdf', 25, now - 600_000)];
    expect(newDownloads(before, after, now)).toHaveLength(1);
  });

  test('nothing new is nothing', () => {
    const list = [file('a.pdf', 1, now - 60_000)];
    expect(newDownloads(list, list, now)).toEqual([]);
  });
});

// The watcher polls every 15 s but will not read a file until it has been still for 20 s, so the first sighting of
// every download is always too fresh. What the snapshot does with a file it is not ready to announce is the whole
// question: advancing past it means nothing downloaded while the app is running is ever announced.
describe('folderPass', () => {
  const t0 = 1_000_000;
  const receipt = (mtime = t0) => file('receipt.pdf', 900, mtime);
  const poll = (previous: WatchedFile[], current: WatchedFile[], at: number, due = true, quiet = false) =>
    folderPass(previous, current, at, { due, quiet });

  test('a file first seen inside the settle window is announced on a later pass, not lost', () => {
    const first = poll([], [receipt()], t0 + 15_000);
    expect(first.fire).toEqual([]);
    // Still new: the next pass has to see it again to ever announce it.
    expect(first.next).toEqual([]);
    const second = poll(first.next, [receipt()], t0 + 30_000);
    expect(second.fire.map((f) => f.name)).toEqual(['receipt.pdf']);
  });

  test('an announced file is not announced again', () => {
    const pass = poll([], [receipt()], t0 + 60_000);
    expect(pass.fire).toHaveLength(1);
    expect(poll(pass.next, [receipt()], t0 + 75_000).fire).toEqual([]);
  });

  test('a batch held back by the gap between announcements goes out on the next pass', () => {
    const seen = file('seen.pdf', 1, t0 - 600_000);
    const now = [seen, receipt()];
    const held = poll([seen], now, t0 + 60_000, false);
    expect(held.fire).toEqual([]);
    expect(poll(held.next, now, t0 + 75_000).fire.map((f) => f.name)).toEqual(['receipt.pdf']);
  });

  test('quiet hours drop the batch rather than holding it for the morning', () => {
    const pass = poll([], [receipt()], t0 + 60_000, true, true);
    expect(pass.fire).toEqual([]);
    expect(pass.next.map((f) => f.name)).toEqual(['receipt.pdf']);
  });

  test('a file that disappeared leaves the snapshot', () => {
    expect(poll([file('gone.pdf', 1, t0 - 600_000)], [], t0, false).next).toEqual([]);
  });
});

describe('downloadsPrompt', () => {
  test('lists the paths and sizes and asks for a judgment', () => {
    const p = downloadsPrompt([file('statement.pdf', 204_800)], '/Users/me/Downloads');
    expect(p).toContain('[downloads]');
    expect(p).toContain('Downloads');
    expect(p).toContain('statement.pdf');
    expect(p).toContain('200 KB');
    expect(p).toContain('If it needs nothing');
  });
});

describe('meetingsSoon', () => {
  const now = 1_000_000;

  test('finds meetings inside the lead window, soonest first', () => {
    const events = [event('Later', now + 20 * 60_000), event('Soon', now + 5 * 60_000)];
    expect(meetingsSoon(events, now, 15 * 60_000, new Set()).map((e) => e.title)).toEqual(['Soon']);
  });

  test('ignores meetings that already started, are too far away, or were announced', () => {
    const events = [event('Started', now - 60_000), event('Tomorrow', now + 86_400_000), event('Announced', now + 5 * 60_000)];
    const announced = new Set([meetingKey(events[2])]);
    expect(meetingsSoon(events, now, 15 * 60_000, announced)).toEqual([]);
  });

  test('a lead of zero turns meeting prep off', () => {
    expect(meetingsSoon([event('Soon', now + 60_000)], now, 0, new Set())).toEqual([]);
  });
});

describe('meetingPrompt', () => {
  test('says when, where and what to prepare', () => {
    const now = Date.UTC(2026, 9, 22, 14, 50);
    const p = meetingPrompt({ title: 'Design review', start: now + 10 * 60_000, end: now + 40 * 60_000, location: 'Room 4' }, now, 'UTC');
    expect(p).toContain('[calendar]');
    expect(p).toContain('Design review');
    expect(p).toContain('in 10 minutes');
    expect(p).toContain('Room 4');
    expect(p).toContain('meeting-prep');
  });
});

describe('rate limits', () => {
  test('the folder warns at most once a minute', () => {
    expect(folderDue(0, 30_000)).toBe(false);
    expect(folderDue(0, 60_000)).toBe(true);
    expect(folderDue(0, 61_000, 10_000)).toBe(true);
  });

  test('webhooks are capped per ten minutes, and old hits fall out of the window', () => {
    const now = 10_000_000;
    const hits = Array.from({ length: 60 }, () => now - 1_000);
    expect(webhookAllowed(hits, now)).toBe(false);
    expect(recentHits(hits, now + 11 * 60_000)).toEqual([]);
    expect(webhookAllowed(hits, now + 11 * 60_000)).toBe(true);
    expect(webhookAllowed([], now)).toBe(true);
  });
});
describe("webhookIpAllowed", () => {
  test("allows up to the per-IP cap, then throttles that source", () => {
    const now = 5_000_000;
    const hits = Array.from({ length: 29 }, (_, i) => now - (i + 1) * 1000);
    expect(webhookIpAllowed(hits, now)).toBe(true);
    expect(webhookIpAllowed([...hits, now], now)).toBe(false);
  });

  test("hits outside the minute window do not count", () => {
    const now = 5_000_000;
    const hits = Array.from({ length: 31 }, () => now - 61_000);
    expect(webhookIpAllowed(hits, now)).toBe(true);
  });
});

describe('inboundIp', () => {
  const req = (xff?: string) => new Request('https://duet.example/api/webhooks/tok', xff !== undefined ? { headers: { 'x-forwarded-for': xff } } : {});

  test('trusts X-Forwarded-For only when the direct peer is loopback', () => {
    expect(inboundIp(req('203.0.113.5'), '127.0.0.1')).toBe('203.0.113.5');
    expect(inboundIp(req('2001:db8::7, 127.0.0.1'), '::1')).toBe('2001:db8::7');
    expect(inboundIp(req('198.51.100.42'), '::ffff:127.0.0.1')).toBe('198.51.100.42');
    expect(inboundIp(req('198.51.100.42'), '::FFFF:127.0.0.1')).toBe('198.51.100.42');
  });

  test('falls back to loopback when X-Forwarded-For is absent or malformed', () => {
    expect(inboundIp(req(), '127.0.0.1')).toBe('127.0.0.1');
    expect(inboundIp(req(''), '::1')).toBe('::1');
    expect(inboundIp(req('not-an-ip'), '127.0.0.1')).toBe('127.0.0.1');
  });

  test('ignores spoofed X-Forwarded-For when the direct peer is not loopback', () => {
    expect(inboundIp(req('127.0.0.1'), '198.51.100.9')).toBe('198.51.100.9');
    expect(inboundIp(req('10.0.0.5'), '198.51.100.9')).toBe('198.51.100.9');
    expect(inboundIp(req('192.168.1.10'))).toBe('unknown');
    expect(inboundIp(req('127.0.0.1'))).toBe('unknown');
  });
});
