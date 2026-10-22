// Hermes Duet service worker: web push + notification taps. No offline caching on purpose:
// the thread is live state, and a stale shell is worse than a spinner.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Hermes Duet', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Hermes Duet';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/', card_id: data.card_id || null, ask: Boolean(data.ask), sent_at: data.sent_at || 0 },
    // Action buttons show on Android/desktop; iOS ignores them and just opens the app. An approval whose draft
    // or command is only in the card never gets Approve here: its first button opens the card instead.
    // `has_draft` is the older name of `must_read`, accepted for pushes queued before the rename.
    actions: data.card_id && data.approval
      ? [
          data.must_read || data.has_draft
            ? { action: 'open', title: 'Read it first' }
            : { action: 'approve', title: data.action_label || 'Approve' },
          { action: 'decline', title: 'Not now' },
        ]
      : [],
  };
  event.waitUntil(
    (async () => {
      if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator) {
        await (data.badge ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge()).catch(() => {});
      }
      // Always show: WebKit counts a push that shows nothing as a silent push and revokes the
      // subscription after a few. The server already skips devices whose app is visible.
      await self.registration.showNotification(title, options);
      // `open` lists every approval and question still pending when this push was sent. An earlier ask banner whose
      // card isn't in it was settled elsewhere (another device, a redraft, its run ended), so take it down. Banners
      // sent after this push (out-of-order delivery) are left alone; pushes without `open` clear nothing.
      if (Array.isArray(data.open)) {
        const open = new Set(data.open);
        const shown = await self.registration.getNotifications().catch(() => []);
        for (const n of shown) {
          const d = n.data || {};
          if (d.ask && d.card_id && !open.has(d.card_id) && (d.sent_at || 0) <= (data.sent_at || 0)) n.close();
        }
      }
    })(),
  );
});

// The push service rotated or expired the subscription: make a new one and hand it to the server.
// The old endpoint is dropped server-side the first time a send to it returns 404/410.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      let sub = event.newSubscription;
      if (!sub) {
        const res = await fetch('/api/push/key', { credentials: 'include' });
        if (!res.ok) return;
        const { key } = await res.json();
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    })().catch(() => {}),
  );
});

function b64ToBytes(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

self.addEventListener('notificationclick', (event) => {
  const { url, card_id } = event.notification.data || {};
  event.notification.close();
  event.waitUntil(
    (async () => {
      if (card_id && (event.action === 'approve' || event.action === 'decline')) {
        await fetch(`/api/cards/${encodeURIComponent(card_id)}/act`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: event.action }),
        }).catch(() => {});
        return;
      }
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = new URL(url || '/', self.location.origin).href;
      for (const w of wins) {
        if ('focus' in w) {
          await w.focus();
          w.postMessage({ type: 'open', url: target, card_id });
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
