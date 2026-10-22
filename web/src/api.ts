import type { Item, ServerEvent, Settings, Snapshot } from '../../shared/types';
import { applyEvent, applySnapshot, getState, prependItems, setState } from './store';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    setState({ authed: false, ready: true });
    throw new HttpError(401, 'not paired');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    throw new HttpError(res.status, msg || res.statusText);
  }
  return (await res.json()) as T;
}

export const api = {
  pair: (code: string) => call<{ ok: true }>('POST', '/api/pair', { code }),
  snapshot: () => call<Snapshot>('GET', '/api/state'),
  older: (before: string) => call<{ items: Item[]; has_more: boolean }>('GET', `/api/items?before=${encodeURIComponent(before)}`),
  send: (text: string) => call<{ item: Item }>('POST', '/api/messages', { text }),
  act: (cardId: string, action: string, value?: string) =>
    call<{ item: Item }>('POST', `/api/cards/${encodeURIComponent(cardId)}/act`, { action, value }),
  stop: () => call<{ ok: true }>('POST', '/api/runs/stop'),
  cancelTask: (id: string) => call<{ ok: true }>('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`),
  stopPage: (id: string) => call<{ ok: true }>('DELETE', `/api/pages/${encodeURIComponent(id)}`),
  saveSettings: (s: Partial<Settings>) => call<{ settings: Settings }>('PUT', '/api/settings', s),
  runBrief: () => call<{ ok: true }>('POST', '/api/brief/run'),
  pushKey: () => call<{ key: string }>('GET', '/api/push/key'),
  subscribe: (sub: PushSubscriptionJSON) => call<{ ok: true }>('POST', '/api/push/subscribe', sub),
  testPush: () => call<{ sent: number }>('POST', '/api/push/test'),
};

let es: EventSource | null = null;
let retry = 0;

export async function connect() {
  try {
    applySnapshot(await api.snapshot());
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return;
    setState({ connected: false, ready: getState().ready });
    setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
    return;
  }
  es?.close();
  es = new EventSource('/api/events', { withCredentials: true });
  es.onopen = () => {
    retry = 0;
    setState({ connected: true });
  };
  es.onmessage = (m) => {
    try {
      applyEvent(JSON.parse(m.data) as ServerEvent);
    } catch {}
  };
  es.onerror = () => {
    setState({ connected: false });
    es?.close();
    es = null;
    // Resync from a fresh snapshot: deltas missed while offline are not replayed.
    setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
  };
}

export async function loadOlder() {
  const first = getState().items[0];
  if (!first) return;
  const r = await api.older(first.id);
  prependItems(r.items, r.has_more);
}

/** Page back until `id` is in the loaded thread, so a jump to an old pending card lands. */
export async function loadUntil(id: string, maxPages = 20) {
  for (let i = 0; i < maxPages; i++) {
    const s = getState();
    if (s.items.some((x) => x.id === id) || !s.hasMore) return;
    await loadOlder();
  }
}

document.addEventListener('visibilitychange', () => {
  // iOS suspends EventSource in the background; reconnect on return.
  if (document.visibilityState === 'visible' && getState().authed && (!es || es.readyState === EventSource.CLOSED)) {
    connect();
  }
});

function urlB64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api.pushKey();
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
  await api.subscribe(sub.toJSON());
  setState({ pushEnabled: true });
  return 'ok';
}
