import { useSyncExternalStore } from 'react';
import type { AgentState, FileEntry, Item, ServerEvent, Settings, Snapshot, Task } from '../../shared/types';

export interface State {
  ready: boolean;
  authed: boolean | null; // null = unknown yet
  connected: boolean;
  items: Item[];
  hasMore: boolean;
  tasks: Task[];
  files: FileEntry[];
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
  tasks: [],
  files: [],
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
  setState({
    ready: true,
    authed: true,
    items: s.items,
    hasMore: s.has_more,
    tasks: s.tasks.sort(byUpdatedDesc),
    files: s.files,
    settings: s.settings,
    agent: s.agent,
    pushEnabled: s.push_enabled,
  });
}

export function prependItems(older: Item[], hasMore: boolean) {
  setState((s) => ({ items: [...older.filter((o) => !s.items.some((i) => i.id === o.id)), ...s.items], hasMore }));
}

export function applyEvent(ev: ServerEvent) {
  switch (ev.type) {
    case 'item':
      setState((s) => ({ items: upsert(s.items, ev.item, byCreated) }));
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
      setState((s) => ({ files: [ev.file, ...s.files.filter((f) => f.id !== ev.file.id)] }));
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
