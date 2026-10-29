import { expect, test } from 'bun:test';
import type { Channel, Item, Snapshot } from '../../shared/types';
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

test('general stays first and removing the open channel falls back', () => {
  setState({ channels: [channel('general')], channelId: 'general' });
  applyEvent({ type: 'channel', channel: channel('taxes') });
  expect(getState().channels.map((c) => c.slug)).toEqual(['general', 'taxes']);
  applyEvent({ type: 'channel_removed', id: 'general' });
  expect(getState().channelId).toBe('taxes');
});
