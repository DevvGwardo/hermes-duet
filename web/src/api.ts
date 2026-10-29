import { settledNotifications } from '../../shared/links';
import type { Attachment, Capabilities, Channel, Connector, Item, SearchHit, ServerEvent, Settings, Snapshot, Task } from '../../shared/types';
import { applyEvent, applySnapshot, getState, mergeItems, prependItems, setChannel, setState } from './store';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
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

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(res);
}

export const api = {
  pair: (code: string) => call<{ ok: true }>('POST', '/api/pair', { code }),
  snapshot: () => call<Snapshot>('GET', '/api/state'),
  older: (before: string, channel?: string | null) =>
    call<{ items: Item[]; has_more: boolean }>('GET', `/api/items?before=${encodeURIComponent(before)}${channel ? `&channel=${encodeURIComponent(channel)}` : ''}`),
  send: (text: string, attachmentIds?: string[]) =>
    call<{ item: Item }>('POST', '/api/messages', { text, channel_id: getState().channelId, ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}) }),
  startTask: (text: string, attachmentIds?: string[]) =>
    call<{ item: Item; task: Task }>('POST', '/api/tasks', { text, channel_id: getState().channelId, ...(attachmentIds?.length ? { attachment_ids: attachmentIds } : {}) }),
  /** Upload a camera photo, a document, or a voice memo. The server stores it under data/uploads. */
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name || 'upload');
    return fetch('/api/uploads', { method: 'POST', credentials: 'include', body: form }).then((r) => parse<{ attachment: Attachment }>(r));
  },
  /** Transcribe a recording locally. The server keeps the audio and returns the text plus the stored attachment. */
  transcribe: (blob: Blob) =>
    fetch('/api/audio/transcribe', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
    }).then((r) => parse<{ text: string; attachment: Attachment }>(r)),
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
  capabilities: () => call<Capabilities>('GET', '/api/capabilities'),
  connectors: () => call<{ connectors: Connector[] }>('GET', '/api/connectors'),
  testConnector: (id: string) => call<{ connector: Connector }>('POST', `/api/connectors/${encodeURIComponent(id)}/test`),
  /** A button inside a delivered dashboard: becomes a turn in the general channel. */
  deliverableAction: (fileId: string, action: string, payload?: unknown) =>
    call<{ item: Item }>('POST', `/api/deliverables/${encodeURIComponent(fileId)}/action`, { action, payload }),
  /** `Duet.requestApproval(...)` from a dashboard: posts a real approval card, nothing more. */
  deliverableApproval: (fileId: string, data: { title?: string; summary?: string; action_label?: string }) =>
    call<{ item: Item }>('POST', `/api/deliverables/${encodeURIComponent(fileId)}/approval`, data),
  triggers: () =>
    call<{ webhook_url: string; watch_dir: string | null; meeting_lead_minutes: number; triggers: { id: string; kind: string; last_triggered_at: number | null }[] }>(
      'GET',
      '/api/triggers',
    ),
  vaults: () => call<{ vaults: { id: string; name: string; installed: boolean; ready: boolean; detail: string; hint?: string }[] }>('GET', '/api/browser/vaults'),
  autofill: (provider?: string) => call<{ host: string; vault: string; filled: { user: boolean; pass: boolean } }>('POST', '/api/browser/autofill', { provider }),
  viewport: (mode: 'mobile' | 'desktop') => call<{ mode: string }>('POST', '/api/browser/viewport', { mode }),
  channels: () => call<{ channels: Channel[] }>('GET', '/api/channels'),
  createChannel: (name: string, topic?: string) => call<{ channel: Channel }>('POST', '/api/channels', { name, topic }),
  archiveChannel: (id: string) => call<{ ok: true }>('DELETE', `/api/channels/${encodeURIComponent(id)}`),
  channelPage: (id: string) => call<{ items: Item[]; has_more: boolean }>('GET', `/api/channels/${encodeURIComponent(id)}/items`),
  seenChannel: (id: string) => call<{ ok: true }>('POST', `/api/channels/${encodeURIComponent(id)}/seen`),
  search: (q: string) => call<{ hits: SearchHit[]; terms: string[] }>('GET', `/api/search?q=${encodeURIComponent(q)}`),
};

/**
 * Open a channel: show it, mark it read, and page in its history. The snapshot only carries the newest page of the
 * whole install, so a channel the user has not looked at yet is usually not loaded at all.
 */
export async function openChannel(id: string) {
  setChannel(id);
  api.seenChannel(id).catch(() => {});
  const hasItems = getState().items.some((i) => (i.channel_id ?? id) === id);
  if (hasItems) return;
  const page = await api.channelPage(id);
  mergeItems(page.items);
}

let es: EventSource | null = null;
let retry = 0;

export async function connect() {
  try {
    applySnapshot(await api.snapshot());
    reportPresence();
    resyncPush();
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
  const s = getState();
  const first = s.items[0];
  if (!first) return;
  // Page back through the channel being read, so scrolling history never jumps into another thread.
  const r = await api.older(first.id, s.channelId);
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
  reportPresence();
  // iOS suspends EventSource in the background; reconnect on return.
  if (document.visibilityState === 'visible' && getState().authed && (!es || es.readyState === EventSource.CLOSED)) {
    connect();
  }
});
window.addEventListener('pagehide', () => reportPresence(false));

// Tell the server while this window is on screen, so it skips pushing this device instead of the
// service worker swallowing the push. The server's lease (40s) outlives two missed beats.
const clientId = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const PRESENCE_BEAT_MS = 15_000;

function reportPresence(visible = document.visibilityState === 'visible') {
  if (!getState().authed) return;
  // keepalive lets the "hidden" report leave even as the page is being frozen or closed.
  fetch('/api/presence', {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: clientId, visible }),
  }).catch(() => {});
}
setInterval(() => {
  if (document.visibilityState === 'visible') reportPresence(true);
}, PRESENCE_BEAT_MS);

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
  await subscribeDevice();
  return 'ok';
}

async function subscribeDevice() {
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array((await api.pushKey()).key) }));
  await api.subscribe(sub.toJSON());
  setState({ pushEnabled: true });
}

/** Take banners for questions and approvals that were settled off the lock screen (settledNotifications). */
export async function clearSettledNotifications() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const notes = (await reg?.getNotifications?.()) ?? [];
  if (!notes.length) return;
  const { items, pending } = getState();
  // Pending last, so a card's server-side "still waiting" wins over an older copy in the loaded page.
  const known = new Map([...items, ...pending].map((i) => [i.id, i]));
  for (const n of settledNotifications(notes, (id) => known.get(id))) n.close();
}

let pushSynced = false;

/** Once per launch: if notifications are allowed, re-register this device's subscription. Covers a
 *  subscription the browser dropped (iOS can revoke one) and one the server pruned after a 404/410. */
function resyncPush() {
  if (pushSynced || !pushSupported() || Notification.permission !== 'granted') return;
  pushSynced = true;
  subscribeDevice().catch(() => {
    pushSynced = false;
  });
}
