import { describe, expect, test } from 'bun:test';
import type { Settings } from '../shared/types';
import { hourlySlots, inQuietHours, localParts, toMinutes } from './clock';

const base: Settings = { brief_enabled: true, brief_time: '07:30', checkins: 'off', quiet_start: '21:30', quiet_end: '07:00', timezone: 'America/New_York' };
// 2026-10-21 is EDT (UTC-4).
const at = (hhmmLocal: string) => new Date(`2026-10-21T${hhmmLocal}:00-04:00`);

describe('clock', () => {
  test('toMinutes', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('07:30')).toBe(450);
    expect(toMinutes('23:59')).toBe(1439);
  });

  test('localParts uses the configured timezone', () => {
    const p = localParts('America/New_York', at('07:05'));
    expect(p.hhmm).toBe('07:05');
    expect(p.date).toBe('2026-10-21');
    expect(localParts('Asia/Tokyo', at('07:05')).date).toBe('2026-10-21');
    expect(localParts('Asia/Tokyo', at('07:05')).hhmm).toBe('20:05');
  });

  test('quiet hours that wrap past midnight', () => {
    expect(inQuietHours(base, at('22:00'))).toBe(true);
    expect(inQuietHours(base, at('03:00'))).toBe(true);
    expect(inQuietHours(base, at('07:00'))).toBe(false);
    expect(inQuietHours(base, at('12:00'))).toBe(false);
    expect(inQuietHours(base, at('21:29'))).toBe(false);
  });

  test('quiet hours within one day, and disabled when start == end', () => {
    const day = { ...base, quiet_start: '13:00', quiet_end: '14:00' };
    expect(inQuietHours(day, at('13:30'))).toBe(true);
    expect(inQuietHours(day, at('14:00'))).toBe(false);
    expect(inQuietHours({ ...base, quiet_start: '09:00', quiet_end: '09:00' }, at('09:00'))).toBe(false);
  });

  test('hourly check-in slots stay outside quiet hours', () => {
    const slots = hourlySlots('07:00', '21:30');
    expect(slots[0]).toBe('07:00');
    expect(slots.at(-1)).toBe('21:00');
    expect(slots).toHaveLength(15);
    expect(hourlySlots('07:15', '09:00')).toEqual(['08:00']);
  });
});
