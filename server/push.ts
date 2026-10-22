import webpush from 'web-push';
import { db, items, kv, settings } from './db';
import { config } from './config';
import { inQuietHours } from './clock';
import { presence } from './presence';
import { holdPush, type HeldPush } from './held';

interface Vapid {
  publicKey: string;
  privateKey: string;
}

function vapid(): Vapid {
  let keys = kv.get<Vapid | null>('vapid', null);
  if (!keys) {
    keys = webpush.generateVAPIDKeys();
    kv.set('vapid', keys);
  }
  return keys;
}

const keys = vapid();
// Apple's push service rejects localhost subjects, so prefer the public URL.
webpush.setVapidDetails(config.publicUrl || 'mailto:hermes-duet@users.noreply.github.com', keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

export function saveSubscription(sub: any, deviceId: string) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('bad subscription');
  const url = new URL(sub.endpoint);
  if (url.protocol !== 'https:') throw new Error('bad endpoint');
  db.query(
    `INSERT INTO push_subs(endpoint, json, device_id, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json, device_id = excluded.device_id`,
  ).run(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), deviceId, Date.now());
}

export function hasSubscriptions(deviceId?: string) {
  const row = deviceId
    ? db.query<{ n: number }, [string]>('SELECT COUNT(*) n FROM push_subs WHERE device_id = ?').get(deviceId)
    : db.query<{ n: number }, []>('SELECT COUNT(*) n FROM push_subs').get();
  return (row?.n ?? 0) > 0;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  card_id?: string;
  approval?: boolean;
  /** The approval's draft or command is only in the card, so the notification gets no one-tap Approve. */
  must_read?: boolean;
  action_label?: string;
  /** Send even to a device whose app is open and visible. */
  always?: boolean;
  /** Home-screen badge count; filled in from pending cards when omitted. */
  badge?: number;
}

export async function notify(p: PushPayload, opts: { ignoreQuiet?: boolean } = {}): Promise<number> {
  if (!opts.ignoreQuiet && inQuietHours(settings.get())) {
    // Held, not dropped: the scheduler sends one "While you were away" push for what is still worth it once
    // quiet hours end.
    kv.set('push_held', holdPush(kv.get<HeldPush[]>('push_held', []), p, Date.now()));
    return 0;
  }
  // A device looking at the thread already sees this, so it gets no push at all. The service worker
  // must show every push it receives (iOS revokes subscriptions that push silently).
  const subs = db
    .query<{ endpoint: string; json: string; device_id: string | null }, []>('SELECT endpoint, json, device_id FROM push_subs')
    .all()
    .filter((s) => p.always || !s.device_id || !presence.visible(s.device_id));
  p = { ...p, badge: p.badge ?? items.pendingCards().length };
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(JSON.parse(s.json), JSON.stringify(p), { TTL: 6 * 3600, urgency: p.approval ? 'high' : 'normal' });
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) db.query('DELETE FROM push_subs WHERE endpoint = ?').run(s.endpoint);
        else console.warn('[push] send failed', e?.statusCode ?? '', e?.body ?? e?.message);
      }
    }),
  );
  return sent;
}
