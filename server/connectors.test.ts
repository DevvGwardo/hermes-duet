import { describe, expect, test } from 'bun:test';
import type { Connector } from '../shared/types';
import { connectorBrief, parseCalendarOutput, parseMail, parseReminders } from './connectors';

describe('parseCalendarOutput', () => {
  test('reads tab-separated AppleScript lines', () => {
    const out = parseCalendarOutput(
      ['Design review\t2026-10-22T15:00:00\t2026-10-22T15:30:00\tRoom 4', 'Lunch\t2026-10-22T12:00:00\t2026-10-22T13:00:00\t'].join('\n'),
    );
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Lunch');
    expect(out[0].location).toBeUndefined();
    expect(out[1].title).toBe('Design review');
    expect(out[1].location).toBe('Room 4');
    expect(new Date(out[1].start).getHours()).toBe(15);
  });

  test('skips blank and unparseable lines instead of throwing', () => {
    expect(parseCalendarOutput('')).toEqual([]);
    expect(parseCalendarOutput('\n\n')).toEqual([]);
    expect(parseCalendarOutput('\t2026-10-22T15:00:00')).toEqual([]);
    expect(parseCalendarOutput('Thing\tnot-a-date')).toEqual([]);
  });

  test('sorts by start and falls back to the start for a missing end', () => {
    const out = parseCalendarOutput(['B\t2026-10-22T16:00:00', 'A\t2026-10-22T09:00:00\t2026-10-22T09:30:00'].join('\n'));
    expect(out.map((e) => e.title)).toEqual(['A', 'B']);
    expect(out[1].end).toBe(out[1].start);
  });

  test('caps long titles', () => {
    const out = parseCalendarOutput(`${'x'.repeat(500)}\t2026-10-22T15:00:00`);
    expect(out[0].title.length).toBe(200);
  });
});

describe('parseReminders', () => {
  test('reads remindctl JSON arrays and wrapped objects', () => {
    expect(parseReminders('[{"title":"Renew passport"},{"name":"Water plants"}]')).toEqual(['Renew passport', 'Water plants']);
    expect(parseReminders('{"reminders":[{"title":"Call mum"}]}')).toEqual(['Call mum']);
  });

  test('falls back to plain lines and strips checkbox syntax', () => {
    expect(parseReminders('- [ ] Renew passport\n- [x] Water plants\n')).toEqual(['Renew passport', 'Water plants']);
  });

  test('empty output is an empty list', () => {
    expect(parseReminders('')).toEqual([]);
    expect(parseReminders('[]')).toEqual([]);
    expect(parseReminders('{"reminders":[]}')).toEqual([]);
  });

  test('caps the list', () => {
    const many = Array.from({ length: 80 }, (_, i) => `- item ${i}`).join('\n');
    expect(parseReminders(many)).toHaveLength(50);
  });
});

describe('parseMail', () => {
  test('reads sender, subject and date', () => {
    const mail = parseMail('Dana <dana@example.com>\tLease renewal\t2026-10-22T09:00:00');
    expect(mail[0].from).toBe('Dana <dana@example.com>');
    expect(mail[0].subject).toBe('Lease renewal');
    expect(mail[0].received).toBeGreaterThan(0);
  });

  test('a line without a subject is skipped', () => {
    expect(parseMail('someone\t\t2026-10-22T09:00:00')).toEqual([]);
    expect(parseMail('')).toEqual([]);
  });
});

describe('connectorBrief', () => {
  const conn = (id: string, status: Connector['status']): Connector => ({ id, name: id, kind: 'calendar', status, detail: '' });

  test('only working connectors reach the agent, with the command to use', () => {
    const brief = connectorBrief([conn('calendar', 'active'), conn('reminders', 'active'), conn('mail', 'needs_auth')]);
    expect(brief).toContain('Calendar:');
    expect(brief).toContain('remindctl today --json');
    expect(brief).not.toContain('Mail:');
  });

  test('nothing active means nothing to say', () => {
    expect(connectorBrief([conn('calendar', 'unsupported')])).toBe('');
  });
});