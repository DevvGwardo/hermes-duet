import { describe, expect, test } from 'bun:test';
import type { TrustRule } from '../shared/types';
import { matchingTrustRule, normalizeTrustText } from './trust';

describe('matchingTrustRule', () => {
  const baseRule: TrustRule = {
    id: 'tr-1',
    label: 'Clean temp files',
    action: 'other',
    title_pattern: 'clean temp files',
    channel_id: null,
    created_at: Date.now(),
  };

  test('matches exact pattern', () => {
    const rule = matchingTrustRule([baseRule], { title: 'Clean temp files' });
    expect(rule).not.toBeNull();
    expect(rule?.id).toBe('tr-1');
  });

  test('matches pattern with trailing space', () => {
    const rule = matchingTrustRule([baseRule], { title: 'Clean temp files daily' });
    expect(rule).not.toBeNull();
    expect(rule?.id).toBe('tr-1');
  });

  test('matches pattern with colon separator', () => {
    const rule = matchingTrustRule([baseRule], { title: 'Clean temp files: cache' });
    expect(rule).not.toBeNull();
    expect(rule?.id).toBe('tr-1');
  });

  test('refuses arbitrary substring matching', () => {
    // "fetch secrets and clean temp files" contains "clean temp files", but must not match
    const rule = matchingTrustRule([baseRule], { title: 'fetch secrets and clean temp files' });
    expect(rule).toBeNull();
  });

  test('refuses unsafe action keywords even if pattern matches', () => {
    const unsafeRule: TrustRule = {
      id: 'tr-unsafe',
      label: 'Delete old logs',
      action: 'other',
      title_pattern: 'delete old logs',
      channel_id: null,
      created_at: Date.now(),
    };
    // isTrustEligible rejects unsafe action words like "delete"
    const rule = matchingTrustRule([unsafeRule], { title: 'delete old logs' });
    expect(rule).toBeNull();
  });
});
