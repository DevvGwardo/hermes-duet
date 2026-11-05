// Route-level tests for the HTTP surface. They call the handlers directly, so no port is bound and no real device is
// needed beyond a paired cookie.
import { describe, expect, test } from 'bun:test';
import { createPairCode, deviceCookie, internalToken, redeemPairCode } from './auth';
import { attachments, items, kv, newId, tasks } from './db';
import { hermes } from './hermes';
import { GENERAL_CHANNEL } from './schema';
import { apiError, handleApp, handleInternal, readTextCapped } from './index';
import { MAX_UPLOAD_BYTES } from './uploads';

const BASE = 'http://127.0.0.1:7456';
const INTERNAL_BASE = 'http://127.0.0.1:7457';

let cookie: string | undefined;
async function paired(): Promise<string> {
  if (cookie) return cookie;
  const { code } = createPairCode();
  const token = await redeemPairCode(code, 'test phone');
  if (!token) throw new Error('could not pair the test device');
  cookie = deviceCookie(token, false).split(';')[0]!;
  return cookie;
}

const app = (path: string, init: RequestInit = {}) => handleApp(new Request(`${BASE}${path}`, init));
async function authed(path: string, init: RequestInit = {}) {
  return app(path, { ...init, headers: { cookie: await paired(), ...(init.headers as Record<string, string>) } });
}
const jsonPost = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('paired routes', () => {
  test('health needs no pairing and reveals nothing', async () => {
    const res = await app('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test('an unpaired request is refused with JSON, not the app shell', async () => {
    const res = await app('/api/state');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('a paired request gets the snapshot', async () => {
    const res = await authed('/api/state');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const snap = (await res.json()) as any;
    expect(Array.isArray(snap.items)).toBe(true);
    expect(Array.isArray(snap.pending)).toBe(true);
  });

  test('a background task carries its attachment into the thread and the prompt', async () => {
    const id = newId();
    const path = `/tmp/hermes-duet-test-${id}.pdf`;
    attachments.add({ id, filename: 'receipt.pdf', mime: 'application/pdf', size: 10, path });
    const real = hermes.hasKey;
    hermes.hasKey = () => false;
    try {
      const res = await authed('/api/tasks', jsonPost({ text: '', attachment_ids: [id] }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.item.text).toBe('Look at the file I attached.');
      expect(body.item.attachments?.[0]?.id).toBe(id);
      expect(attachments.get(id)?.item_id).toBe(body.item.id);
      expect(tasks.get(body.task.id)?.instructions).toContain(path);
    } finally {
      hermes.hasKey = real;
    }
  });

  test('a background task refuses an unknown attachment before starting anything', async () => {
    const res = await authed('/api/tasks', jsonPost({ text: 'x', attachment_ids: ['no-such-upload'] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('unknown attachment');
  });

  test('a trailing slash is the same route, not a fall-through', async () => {
    expect((await authed('/api/state/')).status).toBe(200);
    expect((await authed('/api/items/?before=x')).status).toBe(200);
    expect((await authed('/api/channels/')).status).toBe(200);
  });

  test('an unmatched API path is a JSON 404, never the web app', async () => {
    for (const path of ['/api', '/api/nope', '/api/state/nope']) {
      const res = await authed(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(((await res.json()) as any).error).toBe('not found');
    }
  });

  test('a wrong method answers 405 with Allow instead of 404', async () => {
    const res = await authed('/api/state', { method: 'PUT' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('GET');
    expect((await res.json()) as any).toMatchObject({ code: 'method_not_allowed' });
  });

  test('the version is served so client/server drift is visible', async () => {
    const res = await authed('/api/version');
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as any).version).toBe('string');
  });

  test('an upload over the one real limit is refused at the door', async () => {
    const res = await authed('/api/uploads', { method: 'POST', headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) } });
    expect(res.status).toBe(413);
    expect((await res.json()) as any).toMatchObject({ error: 'that file is too large' });
  });

  test('a chunked body is capped while it is read, not after it is buffered', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"'));
        controller.enqueue(new TextEncoder().encode('a'.repeat(300_000)));
        controller.close();
      },
    });
    const req = new Request(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readTextCapped(req, 256_000)).rejects.toThrow('body too large');
  });

  test('a card error keeps its sentence but never gains internals', async () => {
    const res = await authed('/api/cards/no-such-card/act', jsonPost({ action: 'approve' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe('card not found');
    expect(body.code).toBe('not_found');
    expect(body.request_id).toBeTruthy();
  });
});

describe('error shaping', () => {
  test('an internal error is a code plus a request id, with the path logged instead', async () => {
    const logged: unknown[][] = [];
    const real = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    const res = await (async () => apiError(new Error("ENOENT: no such file or directory, open '/Users/someone/hermes-duet/data/duet.db'"), '/api/files/x'))().finally(() => {
      console.error = real;
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as any;
    expect(body.error).toBe('internal');
    expect(body.request_id).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('/Users/');
    expect(JSON.stringify(body)).not.toContain('duet.db');
    // The detail is not lost: it went to the log with the same request id.
    expect(JSON.stringify(logged)).toContain('duet.db');
    expect(String(logged[0]?.[0])).toContain(body.request_id);
  });

  test('a validation sentence the server wrote stays readable', async () => {
    const body = (await apiError(new Error('no such channel'), '/api/items').json()) as any;
    expect(body.error).toBe('no such channel');
    expect(body.code).toBe('not_found');
  });

  test('a message with a path in it is replaced, not echoed', async () => {
    const real = console.error;
    console.error = () => {};
    const body = (await (async () => apiError(new Error('cannot read /etc/passwd'), '/api/x'))()
      .finally(() => {
        console.error = real;
      })
      .then((r) => r.json())) as any;
    expect(body.error).toBe('internal');
  });
});

describe('loopback API', () => {
  const internal = (path: string, init: RequestInit) =>
    handleInternal(new Request(`${INTERNAL_BASE}${path}`, { ...init, headers: { authorization: `Bearer ${internalToken()}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } }));

  test('a request without the token is refused', async () => {
    const res = await handleInternal(new Request(`${INTERNAL_BASE}/internal/status`));
    expect(res.status).toBe(401);
  });

  test('an empty or oversized internal message is refused like the public route', async () => {
    expect((await internal('/internal/message', jsonPost({ text: '   ' }))).status).toBe(400);
    const long = await internal('/internal/message', jsonPost({ text: 'x'.repeat(20_001) }));
    expect(long.status).toBe(400);
    expect(((await long.json()) as any).error).toBe('message too long');
  });

  test('an internal tool error still reads as a sentence for the model', async () => {
    const res = await internal('/internal/tool/request_approval', jsonPost({ args: {} }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('missing title');
  });
});


test('a locked-out pair attempt is told how long to wait', async () => {
  kv.set('pair_failures', Array.from({ length: 8 }, () => Date.now()));
  try {
    const res = await app('/api/pair', jsonPost({ code: 'AAAA-AAAA' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(((await res.json()) as any).code).toBe('too_many');
  } finally {
    kv.set('pair_failures', []);
  }
});

describe('static shell', () => {
  test('a malformed percent escape is a bad request, not a 500', async () => {
    // `decodeURIComponent('/%')` throws, and this runs before the route try/catch: it used to escape as an unhandled
    // rejection and surface Bun's error page for a URL anyone can type.
    for (const path of ['/%', '/%zz']) {
      const res = await app(path);
      expect(res.status).toBe(400);
    }
  });
});

describe('thread paging', () => {
  test('the items route without a cursor returns the newest page, not an empty thread', async () => {
    const now = Date.now();
    items.save({ id: newId(), kind: 'user', channel_id: GENERAL_CHANNEL, created_at: now, updated_at: now, text: 'hc paging probe' });
    const res = await authed('/api/items');
    expect(res.status).toBe(200);
    const page = (await res.json()) as any;
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.at(-1).text).toBe('hc paging probe');
  });

  test('a cursor still pages backwards from that item', async () => {
    const first = (await (await authed('/api/items')).json()) as any;
    const oldest = first.items[0];
    const res = await authed(`/api/items?before=${encodeURIComponent(oldest.id)}`);
    expect(res.status).toBe(200);
    const older = (await res.json()) as any;
    expect(older.items.every((i: any) => i.created_at <= oldest.created_at)).toBe(true);
  });
});
