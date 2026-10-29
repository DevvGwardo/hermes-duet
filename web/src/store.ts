import { useSyncExternalStore } from 'react';
import { trackPending } from '../../shared/pending';
import type { AgentState, Channel, FileEntry, Item, Page, ServerEvent, Settings, Snapshot, Task } from '../../shared/types';

export interface State {
  ready: boolean;
  authed: boolean | null; // null = unknown yet
  connected: boolean;
  items: Item[];
  hasMore: boolean;
  /** Cards waiting on the user, from the server, not filtered from the loaded `items` page. */
  pending: Item[];
  tasks: Task[];
  files: FileEntry[];
  /** Standing pages, pinned at the top of Make. */
  pages: Page[];
  /** Topic channels, newest activity first. */
  channels: Channel[];
  /** The channel the Chat tab is showing; null until the snapshot lands. */
  channelId: string | null;
  settings: Settings | null;
  agent: AgentState;
  pushEnabled: boolean;
}

const initialAgent: AgentState = { busy: false, current_run: null, queued: 0, hermes: 'unknown', background_running: 0 };

let state: State = {
  ready: false,
  authed: null,
  connected: false,
  items: [],
  hasMore: false,
  pending: [],
  tasks: [],
  files: [],
  pages: [],
  channels: [],
  channelId: null,
  settings: null,
  agent: initialAgent,
  pushEnabled: false,
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state),
  );
}

function upsert<T extends { id: string }>(list: T[], value: T, sort?: (a: T, b: T) => number): T[] {
  const i = list.findIndex((x) => x.id === value.id);
  const next = i === -1 ? [...list, value] : list.map((x, j) => (j === i ? value : x));
  return sort ? next.sort(sort) : next;
}

const byCreated = (a: { created_at: number }, b: { created_at: number }) => a.created_at - b.created_at;
const byUpdatedDesc = (a: { updated_at: number }, b: { updated_at: number }) => b.updated_at - a.updated_at;

export function applySnapshot(s: Snapshot) {
  setState((current) => {
    const channels = s.channels ?? [];
    // Keep the channel the user is reading across a reconnect; fall back to general when it was archived.
    const channelId = current.channelId && channels.some((c) => c.id === current.channelId) ? current.channelId : (channels[0]?.id ?? null);
    return {
      ready: true,
      authed: true,
      items: s.items,
      hasMore: s.has_more,
      pending: s.pending,
      tasks: s.tasks.sort(byUpdatedDesc),
      files: s.files,
      pages: s.pages ?? [],
      channels,
      channelId,
      settings: s.settings,
      agent: s.agent,
      pushEnabled: s.push_enabled,
    };
  });
}

/** Switch the Chat tab's channel; the thread renders only that channel's items. */
export function setChannel(id: string) {
  setState({ channelId: id });
}

/** Items the Chat tab should show: everything in the chosen channel, oldest first. */
export function channelItems(s: State): Item[] {
  if (!s.channelId) return s.items;
  return s.items.filter((i) => (i.channel_id ?? s.channels[0]?.id) === s.channelId);
}

export function prependItems(older: Item[], hasMore: boolean) {
  setState((s) => ({ items: [...older.filter((o) => !s.items.some((i) => i.id === o.id)), ...s.items, ...[]].sort(byCreated), hasMore }));
}

/** Fold a freshly fetched channel page into the loaded items, leaving everything else alone. */
export function mergeItems(page: Item[]) {
  setState((s) => ({ items: [...s.items.filter((i) => !page.some((p) => p.id === i.id)), ...page].sort(byCreated) }));
}

export function applyEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'item':
      setState((s) => ({ items: upsert(s.items, ev.item, byCreated), pending: trackPending(s.pending, ev.item) }));
      break;
    case 'delta':
      setState((s) => ({
        items: s.items.map((i) => (i.id === ev.item_id ? { ...i, text: (i.text ?? '') + ev.text } : i)),
      }));
      break;
    case 'task':
      setState((s) => ({ tasks: upsert(s.tasks, ev.task, byUpdatedDesc) }));
      break;
    case 'file':
      // A known file is updated in place (save_page marks one as a page version), so newest-first order holds.
      setState((s) => ({
        files: s.files.some((f) => f.id === ev.file.id) ? s.files.map((f) => (f.id === ev.file.id ? ev.file : f)) : [ev.file, ...s.files],
      }));
      break;
    case 'page':
      setState((s) => ({ pages: upsert(s.pages, ev.page, byCreated) }));
      break;
    case 'page_removed':
      setState((s) => ({ pages: s.pages.filter((p) => p.id !== ev.id) }));
      break;
    case 'channel': {
      // A new or renamed channel joins the strip, but general stays first: the
      // server orders snapshots that way, and a live event must not dethrone it.
      setState((s) => {
        const list = [ev.channel, ...s.channels.filter((c) => c.id !== ev.channel.id)];
        const general = list.find((c) => c.slug === 'general');
        const rest = list.filter((c) => c.slug !== 'general');
        return { channels: general ? [general, ...rest] : list, channelId: s.channelId ?? ev.channel.id };
      });
      break;
    }
    case 'channel_removed':
      setState((s) => {
        const channels = s.channels.filter((c) => c.id !== ev.id);
        return { channels, channelId: s.channelId === ev.id ? (channels[0]?.id ?? null) : s.channelId };
      });
      break;
    case 'agent':
      setState({ agent: ev.agent });
      break;
    case 'settings':
      setState({ settings: ev.settings });
      break;
    case 'hello':
      break;
  }
}
