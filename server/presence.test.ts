import { describe, expect, test } from 'bun:test';
import { PRESENCE_LEASE_MS, Presence } from './presence';

describe('device presence', () => {
  test('a visible window holds its device until it reports hidden', () => {
    const p = new Presence();
    expect(p.visible('phone', 0)).toBe(false);
    p.report('phone', 'w1', true, 0);
    expect(p.visible('phone', 1000)).toBe(true);
    expect(p.visible('laptop', 1000)).toBe(false);
    p.report('phone', 'w1', false, 2000);
    expect(p.visible('phone', 2000)).toBe(false);
  });

  test('a lost "hidden" report stops counting when the lease runs out', () => {
    const p = new Presence();
    p.report('phone', 'w1', true, 0);
    expect(p.visible('phone', PRESENCE_LEASE_MS - 1)).toBe(true);
    expect(p.visible('phone', PRESENCE_LEASE_MS)).toBe(false);
    p.report('phone', 'w1', true, PRESENCE_LEASE_MS + 5);
    expect(p.visible('phone', PRESENCE_LEASE_MS + 10)).toBe(true);
  });

  test('one window hiding leaves another window of the same device visible', () => {
    const p = new Presence();
    p.report('laptop', 'tab-a', true, 0);
    p.report('laptop', 'tab-b', true, 0);
    p.report('laptop', 'tab-a', false, 10);
    expect(p.visible('laptop', 20)).toBe(true);
    p.report('laptop', 'tab-b', false, 30);
    expect(p.visible('laptop', 40)).toBe(false);
  });
});
