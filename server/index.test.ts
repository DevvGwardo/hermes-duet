// Route-level tests for the HTTP surface. They call the handlers directly, so no port is bound and no real device is
// needed beyond a paired cookie.
import { describe, expect, test } from 'bun:test';
import { createPairCode, deviceCookie, internalToken, redeemPairCode } from './auth';
import { attachments, channels, items, kv, newId, pages, tasks } from './db';
import { UserError } from './errors';
import { hermes } from './hermes';
import { GENERAL_CHANNEL } from './schema';
import { apiError, handleApp, handleInternal, readTextCapped } from './index';
import { resetIdempotency, resetLimits } from './limits';
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

  test('an upload of a type we do not take is refused with its reason, not a 500', async () => {
    // The composer accepts `image/*`, so AVIF and friends are selectable but unsupported. The validator writes a
    // sentence for the phone; it must arrive as a 400, not be swallowed as an internal error.
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'scan.avif', { type: 'image/avif' }));
    const res = await authed('/api/uploads', { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain('avif');
  });

  test('a channel name with no letter or number is a 400 with the reason', async () => {
    const res = await authed('/api/channels', jsonPost({ name: '!!!' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain('letter or number');
  });

  test('creating a channel persists instructions and group', async () => {
    const res = await authed('/api/channels', jsonPost({ name: `rules-${newId().slice(-6)}`, topic: 't', instructions: 'Be terse.', group: 'Work' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.channel.instructions).toBe('Be terse.');
    expect(body.channel.group).toBe('Work');
  });

  test('posting an id updates the channel, and empty clears a field', async () => {
    const created = (await (await authed('/api/channels', jsonPost({ name: `edit-${newId().slice(-6)}`, instructions: 'Old.', group: 'Home' }))).json()) as any;
    const res = await authed('/api/channels', jsonPost({ id: created.channel.id, instructions: 'New.', group: '' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.channel.instructions).toBe('New.');
    expect(body.channel.group).toBe(null);
  });

  test('updating a channel that is not there is a 404', async () => {
    const res = await authed('/api/channels', jsonPost({ id: 'chan-no-such', topic: 'x' }));
    expect(res.status).toBe(404);
  });

  test('marking a channel seen records it, and a missing one is a 404', async () => {
    const created = (await (await authed('/api/channels', jsonPost({ name: `seen-${newId().slice(-6)}` }))).json()) as any;
    expect((await authed(`/api/channels/${created.channel.id}/seen`, { method: 'POST' })).status).toBe(200);
    expect(channels.get(created.channel.id)?.seen_at).toBeGreaterThan(0);
    expect((await authed('/api/channels/chan-no-such/seen', { method: 'POST' })).status).toBe(404);
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

  test('a repeated Idempotency-Key returns the first message instead of posting twice', async () => {
    resetIdempotency();
    const key = `probe-${newId()}`;
    const init = jsonPost({ text: 'idempotent probe' });
    const headers = { ...(init.headers as Record<string, string>), 'idempotency-key': key };
    const first = await authed('/api/messages', { ...init, headers });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    const second = await authed('/api/messages', { ...init, headers });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as any;
    expect(secondBody.item.id).toBe(firstBody.item.id);
    expect(secondBody.duplicate).toBe(true);
  });

  test('test pushes are rate-limited per device and say when to retry', async () => {
    resetLimits();
    try {
      for (let i = 0; i < 5; i++) {
        expect((await authed('/api/push/test', { method: 'POST' })).status).toBe(200);
      }
      const refused = await authed('/api/push/test', { method: 'POST' });
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBeTruthy();
      expect(((await refused.json()) as any).code).toBe('too_many');
    } finally {
      resetLimits();
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

  test('the hard-block policy lists every always-refused category', async () => {
    const res = await authed('/api/policy');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.map((b: any) => b.id)).toEqual(['bank-wire', 'securities-crypto', 'account-access', 'credential-change', 'account-creation']);
    for (const b of body.blocks) {
      expect(typeof b.title).toBe('string');
      expect(typeof b.detail).toBe('string');
    }
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

  test('a UserError keeps its sentence and status, while a plain Error is still replaced', async () => {
    const kept = await apiError(new UserError('a channel name needs at least one letter or number'), '/api/channels');
    expect(kept.status).toBe(400);
    const body = (await kept.json()) as any;
    expect(body.error).toBe('a channel name needs at least one letter or number');
    expect(body.code).toBe('bad_request');
    // Oversized uploads keep their 413 rather than being read as a generic 400.
    const big = await apiError(new UserError('files are limited to 25 MB', 413), '/api/uploads');
    expect(big.status).toBe(413);
    expect(((await big.json()) as any).code).toBe('too_large');
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

describe('user-confirmed task completion', () => {
  const doneTask = () => {
    const now = Date.now();
    const t = { id: newId(), title: 'hc route done', status: 'done' as const, steps: [], created_at: now, updated_at: now, background: true };
    tasks.save(t);
    return t;
  };

  test('confirm stamps the user completion and reopen clears it', async () => {
    const t = doneTask();
    const confirmed = await authed(`/api/tasks/${t.id}/confirm`, { method: 'POST' });
    expect(confirmed.status).toBe(200);
    const cbody = (await confirmed.json()) as any;
    expect(cbody.task.confirmed_at).toBeTruthy();
    expect(cbody.task.status).toBe('done');
    expect(tasks.get(t.id)!.confirmed_at).toBe(cbody.task.confirmed_at);

    const reopened = await authed(`/api/tasks/${t.id}/reopen`, { method: 'POST' });
    expect(reopened.status).toBe(200);
    expect(((await reopened.json()) as any).task.confirmed_at).toBeUndefined();
    expect(tasks.get(t.id)!.confirmed_at).toBeUndefined();
  });

  test('confirming a task nobody started is a 404, not a 500', async () => {
    const res = await authed('/api/tasks/no-such-task/confirm', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe('no such task');
  });

  test('a wrong method on the new routes answers 405 with Allow', async () => {
    const t = doneTask();
    for (const route of [`/api/tasks/${t.id}/confirm`, `/api/tasks/${t.id}/reopen`, `/api/tasks/${t.id}/message`]) {
      const res = await authed(route, { method: 'GET' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  test('steering validates like a chat message: auth, non-empty, capped', async () => {
    const t = doneTask();
    // No cookie means not paired, even for a well-formed steer.
    const anon = await app(`/api/tasks/${t.id}/message`, jsonPost({ text: 'go faster' }));
    expect(anon.status).toBe(401);

    const empty = await authed(`/api/tasks/${t.id}/message`, jsonPost({ text: '   ' }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as any).error).toBe('empty message');

    const long = await authed(`/api/tasks/${t.id}/message`, jsonPost({ text: 'x'.repeat(20_001) }));
    expect(long.status).toBe(400);
    expect(((await long.json()) as any).error).toBe('message too long');
  });

  test('steering a task with no live run is a 409, not a silent queue', async () => {
    const t = doneTask();
    const res = await authed(`/api/tasks/${t.id}/message`, jsonPost({ text: 'one more thing' }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('nothing to steer');
  });
});

describe('notification preferences', () => {
  const put = (body: unknown) => authed('/api/settings', { ...jsonPost(body), method: 'PUT' });
  const savedSettings = () => kv.get<Record<string, unknown> | null>('settings', null);

  test('a valid patch is stored and returned', async () => {
    const before = savedSettings();
    try {
      const res = await put({ notify_tasks: 'failures', notify_agent: false, max_pushes_per_day: 5 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.settings.notify_tasks).toBe('failures');
      expect(body.settings.notify_agent).toBe(false);
      expect(body.settings.max_pushes_per_day).toBe(5);
    } finally {
      kv.set('settings', before ?? {});
    }
  });

  test('muted channels must exist: unknown ids are dropped and duplicates collapse', async () => {
    const before = savedSettings();
    try {
      const res = await put({ muted_channels: [GENERAL_CHANNEL, GENERAL_CHANNEL, 'chan-nope'] });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).settings.muted_channels).toEqual([GENERAL_CHANNEL]);
    } finally {
      kv.set('settings', before ?? {});
    }
  });

  test('a bad enum, cap or channel list is a 400 with a reason, not a silent ignore', async () => {
    for (const patch of [
      { notify_tasks: 'sometimes' },
      { notify_agent: 'yes' },
      { muted_channels: 'nope' },
      { max_pushes_per_day: -1 },
      { max_pushes_per_day: 101 },
      { max_pushes_per_day: 2.5 },
    ]) {
      const res = await put(patch);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBeTruthy();
    }
  });
});
