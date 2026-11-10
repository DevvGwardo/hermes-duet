import { expect, test } from 'bun:test';
import type { Settings } from '../shared/types';
import { bumpSentDay, isExempt, shouldPush, type PushPrefInput } from './notify-prefs';

const base: Settings = {
  brief_enabled: true,
  brief_time: '07:30',
  checkins: 'off',
  quiet_start: '21:30',
  quiet_end: '07:00',
  timezone: 'America/New_York',
  notify_tasks: 'all',
  notify_agent: true,
  muted_channels: [],
  max_pushes_per_day: 0,
};

const push = (over: Partial<Settings> = {}, input: Partial<PushPrefInput> = {}) =>
  shouldPush({ category: 'system', settings: { ...base, ...over }, ...input });

test('approvals and questions always push, exempt from the channel mute and the daily cap', () => {
  const s = { ...base, muted_channels: ['chan-general'], max_pushes_per_day: 1 };
  expect(shouldPush({ category: 'approval', settings: s, channelId: 'chan-general', todayCount: 5 })).toEqual({ send: true });
  expect(shouldPush({ category: 'question', settings: s, channelId: 'chan-general', todayCount: 5 })).toEqual({ send: true });
  expect(isExempt('approval')).toBe(true);
  expect(isExempt('question')).toBe(true);
  expect(isExempt('brief')).toBe(false);
  expect(isExempt('system')).toBe(false);
});

test('notify_tasks sends every finish, only failures, or nothing', () => {
  expect(push({ notify_tasks: 'all' }, { category: 'task_done' }).send).toBe(true);
  expect(push({ notify_tasks: 'all' }, { category: 'task_failed' }).send).toBe(true);
  expect(push({ notify_tasks: 'failures' }, { category: 'task_done' }).send).toBe(false);
  expect(push({ notify_tasks: 'failures' }, { category: 'task_failed' }).send).toBe(true);
  expect(push({ notify_tasks: 'off' }, { category: 'task_done' }).send).toBe(false);
  expect(push({ notify_tasks: 'off' }, { category: 'task_failed' }).send).toBe(false);
  // An old row with no preference behaves as it always did: everything pushes.
  const legacy = { ...base } as Partial<Settings>;
  delete legacy.notify_tasks;
  expect(shouldPush({ category: 'task_done', settings: legacy as Settings }).send).toBe(true);
  expect(shouldPush({ category: 'task_failed', settings: legacy as Settings }).send).toBe(true);
});

test('notify_agent false drops only agent notify pushes', () => {
  expect(push({ notify_agent: false }, { category: 'agent' }).send).toBe(false);
  expect(push({ notify_agent: false }, { category: 'agent' }).reason).toContain('agent');
  expect(push({ notify_agent: false }, { category: 'system' }).send).toBe(true);
  expect(push({ notify_agent: true }, { category: 'agent' }).send).toBe(true);
});

test('brief and check-in pushes follow their existing switches', () => {
  expect(push({ brief_enabled: false }, { category: 'brief' }).send).toBe(false);
  expect(push({ brief_enabled: true }, { category: 'brief' }).send).toBe(true);
  expect(push({ checkins: 'off' }, { category: 'checkin' }).send).toBe(false);
  expect(push({ checkins: '3x' }, { category: 'checkin' }).send).toBe(true);
  expect(push({ checkins: 'hourly' }, { category: 'checkin' }).send).toBe(true);
});

test('the daily cap blocks the push that would pass it, and 0 means no cap', () => {
  const s = { ...base, max_pushes_per_day: 3 };
  expect(shouldPush({ category: 'system', settings: s, todayCount: 0 }).send).toBe(true);
  expect(shouldPush({ category: 'system', settings: s, todayCount: 2 }).send).toBe(true);
  expect(shouldPush({ category: 'system', settings: s, todayCount: 3 }).send).toBe(false);
  expect(shouldPush({ category: 'system', settings: s, todayCount: 9 }).send).toBe(false);
  expect(shouldPush({ category: 'system', settings: { ...base, max_pushes_per_day: 0 }, todayCount: 50 }).send).toBe(true);
  // The cap never touches an approval or question.
  expect(shouldPush({ category: 'approval', settings: s, todayCount: 9 }).send).toBe(true);
  expect(shouldPush({ category: 'question', settings: s, todayCount: 9 }).send).toBe(true);
});

test('a muted channel suppresses its non-approval pushes only', () => {
  const s = { ...base, muted_channels: ['chan-taxes'] };
  expect(shouldPush({ category: 'system', settings: s, channelId: 'chan-taxes' }).send).toBe(false);
  expect(shouldPush({ category: 'system', settings: s, channelId: 'chan-taxes' }).reason).toContain('muted');
  expect(shouldPush({ category: 'task_done', settings: s, channelId: 'chan-taxes' }).send).toBe(false);
  expect(shouldPush({ category: 'brief', settings: s, channelId: 'chan-taxes' }).send).toBe(false);
  expect(shouldPush({ category: 'system', settings: s, channelId: 'chan-general' }).send).toBe(true);
  // No channel on the push means there is nothing to mute.
  expect(shouldPush({ category: 'system', settings: s }).send).toBe(true);
  expect(shouldPush({ category: 'approval', settings: s, channelId: 'chan-taxes' }).send).toBe(true);
  expect(shouldPush({ category: 'question', settings: s, channelId: 'chan-taxes' }).send).toBe(true);
});

test('a blocked push always says why', () => {
  expect(push({ brief_enabled: false }, { category: 'brief' }).reason).toBeTruthy();
  expect(push({ checkins: 'off' }, { category: 'checkin' }).reason).toBeTruthy();
  expect(push({ notify_tasks: 'off' }, { category: 'task_done' }).reason).toBeTruthy();
  expect(push({ notify_tasks: 'failures' }, { category: 'task_done' }).reason).toBeTruthy();
  expect(push({ notify_agent: false }, { category: 'agent' }).reason).toBeTruthy();
  expect(push({ max_pushes_per_day: 2 }, { todayCount: 2 }).reason).toBeTruthy();
  expect(push().reason).toBeUndefined();
});

test('the sent counter grows for its own local day and starts over on a new one', () => {
  expect(bumpSentDay(null, '2026-11-09')).toEqual({ date: '2026-11-09', count: 1 });
  expect(bumpSentDay(undefined, '2026-11-09')).toEqual({ date: '2026-11-09', count: 1 });
  expect(bumpSentDay({ date: '2026-11-09', count: 4 }, '2026-11-09')).toEqual({ date: '2026-11-09', count: 5 });
  expect(bumpSentDay({ date: '2026-11-08', count: 4 }, '2026-11-09')).toEqual({ date: '2026-11-09', count: 1 });
});
