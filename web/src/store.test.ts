import { expect, test } from 'bun:test';
import type { Channel, Item, Routine, Snapshot } from '../../shared/types';
import { applyEvent, applySnapshot, channelItems, getState, mergeItems, setState } from './store';

const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, kind: 'card', created_at: 1, updated_at: 1, ...extra });
const channel = (id: string, slug = id): Channel => ({ id, name: id, slug, session_id: `s-${id}`, created_at: 1, updated_at: 1 });

const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  items: [],
  has_more: false,
  pending: [],
  tasks: [],
  files: [],
  pages: [],
  channels: [channel('general'), channel('taxes')],
  settings: { brief_enabled: true, brief_time: '07:30', checkins: 'off', quiet_start: '22:00', quiet_end: '07:00', timezone: 'UTC' },
  agent: { busy: false, current_run: null, queued: 0, hermes: 'unknown', background_running: 0 },
  push_enabled: false,
  ...extra,
});

test('snapshot readies the app on the general channel with newest tasks first', () => {
  applySnapshot(
    snapshot({
      tasks: [
        { id: 'old', title: 'Old', status: 'done', steps: [], created_at: 1, updated_at: 1, background: true },
        { id: 'new', title: 'New', status: 'running', steps: [], created_at: 2, updated_at: 2, background: true },
      ] as Snapshot['tasks'],
    }),
  );
  const s = getState();
  expect(s.ready).toBe(true);
  expect(s.authed).toBe(true);
  expect(s.channelId).toBe('general');
  expect(s.tasks.map((t) => t.id)).toEqual(['new', 'old']);
});

test('channel filter shows only the chosen channel, all when none chosen', () => {
  const items = [item('a', { channel_id: 'general' }), item('b', { channel_id: 'taxes' })];
  setState({ items, channels: [channel('general'), channel('taxes')], channelId: 'taxes' });
  expect(channelItems(getState()).map((i) => i.id)).toEqual(['b']);
  setState({ channelId: null });
  expect(channelItems(getState())).toHaveLength(2);
});

test('merge folds a channel page without duplicates, oldest first', () => {
  setState({ items: [item('a', { created_at: 2, updated_at: 2 })] });
  mergeItems([item('a', { created_at: 2, updated_at: 3 }), item('c', { created_at: 1, updated_at: 1 })]);
  expect(getState().items.map((i) => i.id)).toEqual(['c', 'a']);
});

test('item events upsert and deltas append text', () => {
  setState({ items: [], pending: [] });
  applyEvent({ type: 'item', item: item('m', { text: 'hel' }) });
  applyEvent({ type: 'delta', item_id: 'm', text: 'lo' });
  expect(getState().items.find((i) => i.id === 'm')?.text).toBe('hello');
  applyEvent({ type: 'item', item: item('m', { text: 'replaced' }) });
  expect(getState().items.filter((i) => i.id === 'm')).toHaveLength(1);
});

test('the snapshot carries routines soonest-first, and their events upsert and remove', () => {
  const routine = (id: string, next_run: number) => ({ id, title: id, prompt: 'p', schedule: { kind: 'daily', time: '09:00' }, enabled: true, next_run, created_at: 1, updated_at: 1 }) as Routine;
  applySnapshot(snapshot({ routines: [routine('later', 2000), routine('soon', 1000)] }));
  expect(getState().routines.map((r) => r.id)).toEqual(['soon', 'later']);
  applyEvent({ type: 'routine', routine: routine('soon', 500) });
  expect(getState().routines.map((r) => r.id)).toEqual(['soon', 'later']);
  expect(getState().routines.find((r) => r.id === 'soon')?.next_run).toBe(500);
  applyEvent({ type: 'routine_removed', id: 'soon' });
  expect(getState().routines.map((r) => r.id)).toEqual(['later']);
});

test('general stays first and removing the open channel falls back', () => {
  setState({ channels: [channel('general')], channelId: 'general' });
  applyEvent({ type: 'channel', channel: channel('taxes') });
  expect(getState().channels.map((c) => c.slug)).toEqual(['general', 'taxes']);
  applyEvent({ type: 'channel_removed', id: 'general' });
  expect(getState().channelId).toBe('taxes');
});

test('editing an existing channel updates it in place instead of jumping to index 1', () => {
  setState({ channels: [channel('general'), channel('alpha'), channel('beta'), channel('gamma')], channelId: 'beta' });
  applyEvent({ type: 'channel', channel: { ...channel('gamma'), topic: 'Updated topic' } });
  expect(getState().channels.map((c) => c.id)).toEqual(['general', 'alpha', 'beta', 'gamma']);
  expect(getState().channels[3].topic).toBe('Updated topic');
  // Editing general keeps it first too.
  applyEvent({ type: 'channel', channel: { ...channel('general'), topic: 'Main' } });
  expect(getState().channels.map((c) => c.id)).toEqual(['general', 'alpha', 'beta', 'gamma']);
  expect(getState().channels[0].topic).toBe('Main');
});

test('snapshot clears stale channelLoading and channelError while preserving active channel', () => {
  setState({ channelId: 'taxes', channelLoading: { taxes: true }, channelError: { taxes: 'offline' } });
  applySnapshot(snapshot());
  const s = getState();
  expect(s.channelId).toBe('taxes');
  expect(s.channelLoading).toEqual({});
  expect(s.channelError).toEqual({});
});
