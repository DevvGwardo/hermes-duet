// Route-level tests for the HTTP surface. They call the handlers directly, so no port is bound and no real device is
// needed beyond a paired cookie.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_EDIT_BYTES } from '../shared/edit';
import type { FileEntry } from '../shared/types';
import { createPairCode, deviceCookie, internalToken, redeemPairCode } from './auth';
import { config } from './config';
import { attachments, channels, files, items, kv, newId, tasks } from './db';
import { UserError } from './errors';
import { hermes } from './hermes';
import { GENERAL_CHANNEL } from './schema';
import { apiError, compressJson, handleApp, handleInternal, readBytesCapped, readTextCapped } from './index';
import { resetIdempotency, resetLimits } from './limits';
import * as browser from './browser';
import { MAX_UPLOAD_BYTES, saveUpload } from './uploads';

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
const jsonPut = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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

  test('creating a channel stores a normalized repo', async () => {
    const res = await authed('/api/channels', jsonPost({ name: `repo-${newId().slice(-6)}`, repo: ' owner/name ' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).channel.repo).toBe('https://github.com/owner/name');
  });

  test('updating a channel repo normalizes it, and empty clears it', async () => {
    const created = (await (await authed('/api/channels', jsonPost({ name: `repoedit-${newId().slice(-6)}` }))).json()) as any;
    const updated = await authed('/api/channels', jsonPost({ id: created.channel.id, repo: 'https://github.com/other/project.git' }));
    expect(((await updated.json()) as any).channel.repo).toBe('https://github.com/other/project');
    const cleared = await authed('/api/channels', jsonPost({ id: created.channel.id, repo: '' }));
    expect(((await cleared.json()) as any).channel.repo).toBe(null);
  });

  test('a repo that is not owner/name or a GitHub URL is a 400 with the reason', async () => {
    const res = await authed('/api/channels', jsonPost({ name: `badrepo-${newId().slice(-6)}`, repo: 'gitlab.com/owner/name' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/github\.com/);
  });

  test('/api/suggestions needs a paired device', async () => {
    const res = await app('/api/suggestions');
    expect(res.status).toBe(401);
  });

  test('/api/suggestions returns the connected summary and read-only suggestions', async () => {
    const res = await authed('/api/suggestions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.suggestions.length).toBeLessThanOrEqual(3);
    expect(Array.isArray(body.connected.apps)).toBe(true);
    expect(Array.isArray(body.connected.connectors)).toBe(true);
    expect(body.connected.toolsets === null || Array.isArray(body.connected.toolsets)).toBe(true);
    for (const s of body.suggestions) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.title).toBe('string');
      expect(typeof s.detail).toBe('string');
    }
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

describe('file versions', () => {
  /** A delivered file on disk, registered like deliver_file would have done. */
  const stored = (name: string, mime: string, over: Partial<FileEntry> = {}) => {
    const id = newId();
    const dir = join(config.dataDir, 'files', id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'original text', 'utf8');
    return files.add({ id, title: name, name, mime, size: 13, created_at: Date.now(), ...over }, path);
  };

  test('saving text creates a new linked version and leaves the original alone', async () => {
    const base = stored('notes.md', 'text/markdown', { task_id: 'task-1', page_id: 'page-1' });
    const res = await authed(`/api/files/${base.id}/versions`, jsonPost({ text: 'edited text' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.file.id).not.toBe(base.id);
    expect(body.file.version_of).toBe(base.id);
    expect(body.file.title).toBe(base.title);
    expect(body.file.name).toBe(base.name);
    expect(body.file.mime).toBe(base.mime);
    expect(body.file.task_id).toBe('task-1');
    expect(body.file.page_id).toBe('page-1');
    expect(body.file.size).toBe(Buffer.byteLength('edited text', 'utf8'));
    // The original row and its bytes are untouched, and the new file has its own storage path.
    expect(files.get(base.id)!.entry.version_of).toBeUndefined();
    expect(await Bun.file(files.get(base.id)!.path).text()).toBe('original text');
    expect(files.get(body.file.id)!.path).not.toBe(files.get(base.id)!.path);
    expect(await Bun.file(files.get(body.file.id)!.path).text()).toBe('edited text');
    // The new version is served like any other deliverable.
    const got = await authed(`/api/files/${body.file.id}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('edited text');
  });

  test('a file that is not text is refused with a clear sentence, not a 500', async () => {
    for (const [name, mime] of [
      ['scan.pdf', 'application/pdf'],
      ['photo.png', 'image/png'],
      ['archive.zip', 'application/zip'],
    ] as const) {
      const base = stored(name, mime);
      const res = await authed(`/api/files/${base.id}/versions`, jsonPost({ text: 'x' }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toContain('only text files');
      expect(files.all().some((f) => f.version_of === base.id)).toBe(false);
    }
  });

  test('a text over 2 MB is refused with 413', async () => {
    const base = stored('big.md', 'text/markdown');
    const res = await authed(`/api/files/${base.id}/versions`, jsonPost({ text: 'a'.repeat(MAX_EDIT_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toContain('2 MB');
    expect(files.all().some((f) => f.version_of === base.id)).toBe(false);
    expect(await Bun.file(files.get(base.id)!.path).text()).toBe('original text');
  });

  test('a text of exactly 2 MB is accepted, even when escaping doubles the body', async () => {
    const base = stored('edges.md', 'text/markdown');
    const text = '\n'.repeat(MAX_EDIT_BYTES);
    const res = await authed(`/api/files/${base.id}/versions`, jsonPost({ text }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).file.size).toBe(MAX_EDIT_BYTES);
  });

  test('an oversized body is refused at the door', async () => {
    const base = stored('big.md', 'text/markdown');
    const res = await authed(`/api/files/${base.id}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(MAX_EDIT_BYTES * 2 + 8192) },
    });
    expect(res.status).toBe(413);
  });

  test('a missing text field is a 400, not an empty file', async () => {
    const base = stored('notes.md', 'text/markdown');
    for (const payload of [{}, { text: 42 }, { text: null }]) {
      const res = await authed(`/api/files/${base.id}/versions`, jsonPost(payload));
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe('send the file text as JSON');
    }
    expect(files.all().some((f) => f.version_of === base.id)).toBe(false);
  });

  test('an unknown or empty file id is a 404', async () => {
    const missing = await authed('/api/files/no-such-file/versions', jsonPost({ text: 'x' }));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error).toBe('no such file');
    const empty = await authed('/api/files//versions', jsonPost({ text: 'x' }));
    expect(empty.status).toBe(404);
  });

  test('an unpaired request is refused, and a wrong method gets 405 with Allow', async () => {
    const base = stored('notes.md', 'text/markdown');
    const anon = await app(`/api/files/${base.id}/versions`, jsonPost({ text: 'x' }));
    expect(anon.status).toBe(401);
    const wrong = await authed(`/api/files/${base.id}/versions`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
  });
});

describe('memory routes', () => {
  const ORIGINAL_CONTEXT = config.contextFile;
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duet-memory-route-'));
    path = join(dir, 'context.local.md');
    config.contextFile = path;
  });
  afterEach(() => {
    config.contextFile = ORIGINAL_CONTEXT;
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET returns the default empty state with the configured path', async () => {
    const res = await authed('/api/memory');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path, text: '', max_bytes: 32768 });
  });

  test('PUT writes the text and GET reads it back', async () => {
    const text = '- Tasks: run `todo list --today`';
    const put = await authed('/api/memory', jsonPut({ text }));
    expect(put.status).toBe(200);
    expect(((await put.json()) as any).text).toBe(text);
    expect(readFileSync(path, 'utf8')).toBe(text);
    const get = await authed('/api/memory');
    expect(((await get.json()) as any).text).toBe(text);
  });

  test('PUT over the 32 KB cap is a 413 and writes nothing', async () => {
    const res = await authed('/api/memory', jsonPut({ text: 'x'.repeat(32769) }));
    expect(res.status).toBe(413);
    expect(existsSync(path)).toBe(false);
  });

  test('DELETE clears the file and returns the empty state', async () => {
    await authed('/api/memory', jsonPut({ text: 'remember this' }));
    const res = await authed('/api/memory', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path, text: '', max_bytes: 32768 });
    expect(existsSync(path)).toBe(false);
  });

  test('needs pairing, like every other app route', async () => {
    expect((await app('/api/memory')).status).toBe(401);
    expect((await app('/api/memory', jsonPut({ text: 'x' }))).status).toBe(401);
    expect((await app('/api/memory', { method: 'DELETE' })).status).toBe(401);
  });

  test('ignores a path in the body: only the configured context file is touched', async () => {
    const other = join(dir, 'other.md');
    writeFileSync(other, 'untouched');
    const res = await authed('/api/memory', jsonPut({ path: other, text: 'redirected' }));
    expect(res.status).toBe(200);
    expect(readFileSync(other, 'utf8')).toBe('untouched');
    expect(readFileSync(path, 'utf8')).toBe('redirected');
    const get = await authed('/api/memory');
    expect(((await get.json()) as any).path).toBe(path);
  });

  test('a wrong method is a 405 with Allow', async () => {
    const res = await authed('/api/memory', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, PUT, DELETE');
  });
});

describe('phase 2 API & security hardening', () => {
  test('GET /api/items/:id and GET /api/files/:id/meta work and enforce 404/405', async () => {
    const created = await authed('/api/messages', jsonPost({ text: 'lookup item probe' }));
    expect(created.status).toBe(200);
    const createdItem = ((await created.json()) as any).item;

    const gotItem = await authed(`/api/items/${createdItem.id}`);
    expect(gotItem.status).toBe(200);
    expect(((await gotItem.json()) as any).item.id).toBe(createdItem.id);
    expect((await authed('/api/items/item-does-not-exist')).status).toBe(404);
    const wrongItemMethod = await authed(`/api/items/${createdItem.id}`, { method: 'POST' });
    expect(wrongItemMethod.status).toBe(405);
    expect(wrongItemMethod.headers.get('allow')).toBe('GET');

    const fileId = newId();
    const fileDir = join(config.dataDir, 'files', fileId);
    mkdirSync(fileDir, { recursive: true });
    const fPath = join(fileDir, 'report.txt');
    writeFileSync(fPath, 'hello report');
    files.add({ id: fileId, title: 'Report', name: 'report.txt', mime: 'text/plain', size: 12, created_at: Date.now() }, fPath);

    const gotMeta = await authed(`/api/files/${fileId}/meta`);
    expect(gotMeta.status).toBe(200);
    expect(((await gotMeta.json()) as any).file).toMatchObject({ id: fileId, name: 'report.txt', size: 12 });
    expect((await authed('/api/files/no-such-file/meta')).status).toBe(404);
    expect((await authed(`/api/files/${fileId}/meta`, { method: 'POST' })).status).toBe(405);

    for (const [route, allow] of [
      ['/api/browser/ws', 'GET'],
      [`/api/deliverables/${fileId}/action`, 'POST'],
      [`/api/deliverables/${fileId}/approval`, 'POST'],
    ] as const) {
      const m = allow === 'GET' ? 'POST' : 'GET';
      const r = await authed(route, { method: m });
      expect(r.status).toBe(405);
      expect(r.headers.get('allow')).toBe(allow);
    }
  });

  test('archived channels are rejected across channel edit, items, seen, and sends', async () => {
    const ch = ((await (await authed('/api/channels', jsonPost({ name: `arch-${newId().slice(-6)}` }))).json()) as any).channel;
    const del = await authed(`/api/channels/${ch.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    expect((await authed('/api/channels', jsonPost({ id: ch.id, topic: 'late' }))).status).toBe(404);
    expect((await authed(`/api/items?channel=${encodeURIComponent(ch.id)}`)).status).toBe(404);
    expect((await authed(`/api/channels/${ch.id}/seen`, { method: 'POST' })).status).toBe(404);
    expect((await authed(`/api/channels/${ch.id}/items`)).status).toBe(404);
    expect((await authed('/api/messages', jsonPost({ text: 'after archive', channel_id: ch.id }))).status).toBe(404);
  });

  test('PUT /api/settings validates timezone when provided', async () => {
    for (const badTz of ['Mars/Olympus_Mons', '', 123, null]) {
      const res = await authed('/api/settings', jsonPut({ timezone: badTz }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error).toBe('invalid timezone');
    }
    const ok = await authed('/api/settings', jsonPut({ timezone: 'America/New_York' }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).settings.timezone).toBe('America/New_York');
  });

  test('body parsing validates JSON shape, handles /api/pair bad JSON cleanly, and throws 413 on overflow', async () => {
    const cookieHdr = await paired();
    for (const badBody of ['{not-json', 'null', '[]', '"hello"', '123']) {
      const pairRes = await app('/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: badBody,
      });
      expect(pairRes.status).toBe(400);

      const chRes = await app('/api/channels', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHdr },
        body: badBody,
      });
      expect(chRes.status).toBe(400);
      expect(((await chRes.json()) as any).code).toBe('bad_request');
    }

    const wrongCt = await authed('/api/channels', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(wrongCt.status).toBe(400);

    const oversize = new Request(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '300000' },
      body: 'x',
    });
    await expect(readTextCapped(oversize, 256_000)).rejects.toMatchObject({ status: 413, message: 'body too large' });

    expect(apiError(new UserError('busy', 409), '/api/x').status).toBe(409);
    expect(((await apiError(new UserError('busy', 409), '/api/x').json()) as any).code).toBe('conflict');
    expect(((await apiError(new UserError('down', 503), '/api/x').json()) as any).code).toBe('unavailable');
  });

  test('webhook IP rate limit runs BEFORE webhookMatches and falls back to socket IP', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;
    const fakeServer = { requestIP: () => ({ address: ip }) };
    let saw429 = false;
    for (let i = 0; i < 40; i++) {
      const req = new Request(`${BASE}/api/webhooks/wrong-token-${i}`, { method: 'POST' });
      const res = await handleApp(req, fakeServer);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(saw429).toBe(true);
  });

  test('concurrent Idempotency-Key deduplicates in-flight POST /api/messages without burning quota', async () => {
    resetIdempotency();
    resetLimits();
    const cookieHdr = await paired();
    const key = `conc-${newId()}`;

    const makeStreamReq = () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('{"text":'));
          await Bun.sleep(20);
          ctrl.enqueue(new TextEncoder().encode('"concurrent idemp test"}'));
          ctrl.close();
        },
      });
      return new Request(`${BASE}/api/messages`, {
        method: 'POST',
        headers: {
          cookie: cookieHdr,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
    };

    const [r1, r2] = await Promise.all([handleApp(makeStreamReq()), handleApp(makeStreamReq())]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as any;
    const b2 = (await r2.json()) as any;
    expect(b1.item.id).toBe(b2.item.id);
    expect(Boolean(b1.duplicate) !== Boolean(b2.duplicate)).toBe(true);

    // Repeating the remembered key past the 60/min budget still returns the item without hitting 429.
    for (let i = 0; i < 65; i++) {
      const replay = await authed('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ text: 'concurrent idemp test' }),
      });
      expect(replay.status).toBe(200);
    }
    resetLimits();

    // POST /api/tasks also supports Idempotency-Key deduplication.
    const realHasKey = hermes.hasKey;
    hermes.hasKey = () => false;
    try {
      const tKey = `task-${newId()}`;
      const t1 = await authed('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': tKey },
        body: JSON.stringify({ text: 'dedup task' }),
      });
      const t2 = await authed('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': tKey },
        body: JSON.stringify({ text: 'dedup task' }),
      });
      const tb1 = (await t1.json()) as any;
      const tb2 = (await t2.json()) as any;
      expect(tb2.item.id).toBe(tb1.item.id);
      expect(tb2.task.id).toBe(tb1.task.id);
      expect(tb2.duplicate).toBe(true);
    } finally {
      hermes.hasKey = realHasKey;
    }
  });

  test('raw /api/audio/transcribe caps chunked streams and sanitizes 503 engine leaks', async () => {
    const bigStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array(1024));
      },
    });
    const overReq = new Request(`${BASE}/api/audio/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm', 'content-length': String(MAX_UPLOAD_BYTES + 1) },
      body: bigStream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    await expect(readBytesCapped(overReq, MAX_UPLOAD_BYTES)).rejects.toMatchObject({ status: 413 });

    const chunkedOver = new Request(`${BASE}/api/audio/transcribe`, {
      method: 'POST',
      headers: { cookie: await paired(), 'content-type': 'audio/webm' },
      body: new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new Uint8Array(1024));
          ctrl.enqueue(new Uint8Array(MAX_UPLOAD_BYTES));
          ctrl.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const overRes = await handleApp(chunkedOver);
    expect(overRes.status).toBe(413);

    const savedUrl = process.env.DUET_STT_URL;
    const realFetch = globalThis.fetch;
    const realErr = console.error;
    console.error = () => {};
    process.env.DUET_STT_URL = 'http://secret-whisper.internal:8080/transcribe';
    globalThis.fetch = (async () => new Response('<html>internal host secret-whisper.internal:8080 crashed</html>', { status: 502 })) as any;
    try {
      const res = await authed('/api/audio/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/webm' },
        body: new Uint8Array([1, 2, 3, 4]),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.text).toBe('');
      expect(body.attachment.id).toBeTruthy();
      expect(body.error).toBe('Transcription failed (502)');
      expect(JSON.stringify(body)).not.toContain('secret-whisper.internal');
    } finally {
      if (savedUrl === undefined) delete process.env.DUET_STT_URL;
      else process.env.DUET_STT_URL = savedUrl;
      globalThis.fetch = realFetch;
      console.error = realErr;
    }
  });

  test('/api/browser/autofill sanitizes internal path leaks', async () => {
    const savedPort = process.env.DUET_CHROME_PORT;
    const savedBin = process.env.DUET_CHROME_BIN;
    const savedOp = process.env.DUET_OP_CMD;
    const realErr = console.error;
    console.error = () => {};
    let wsPort = 0;
    const cdpSrv = Bun.serve({
      port: 0,
      fetch(req, server): Response | undefined {
        const u = new URL(req.url);
        if (u.pathname === '/json/version') {
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${wsPort}/cdp` });
        }
        if (u.pathname === '/cdp' && server.upgrade(req)) return undefined;
        return new Response('nope', { status: 404 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
          if (msg.method === 'Target.getTargets') {
            ws.send(JSON.stringify({ id: msg.id, result: { targetInfos: [{ targetId: 't1', type: 'page', title: 'Shop', url: 'https://shop.example/login' }] } }));
          } else if (msg.method === 'Target.attachToTarget') {
            ws.send(JSON.stringify({ id: msg.id, result: { sessionId: 's1' } }));
          } else if (msg.method === 'Runtime.evaluate') {
            ws.send(JSON.stringify({ id: msg.id, result: { result: { value: 'https://shop.example/login' } } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: {} }));
          }
        },
      },
    });
    wsPort = cdpSrv.port ?? 0;
    process.env.DUET_CHROME_PORT = '19999';
    process.env.DUET_CHROME_BIN = '/nonexistent/secret/chrome/path';
    process.env.DUET_OP_CMD = '/nonexistent/op/bin get {domain}';
    const vault = await import('./vault');
    const prevHas = vault.__setVaultHas(() => true);
    const prevRunner = vault.__setVaultRunner(async () => ({
      out: '',
      err: 'spawn ENOENT /var/internal/op-wrapper/bin',
      code: 1,
    }));
    browser.close();
    try {
      const noTabRes = await authed('/api/browser/autofill', jsonPost({}));
      expect(noTabRes.status).toBe(400);
      expect(((await noTabRes.json()) as any).error).toBe('no active tab');

      process.env.DUET_CHROME_PORT = String(wsPort);
      await browser.open();
      const res = await authed('/api/browser/autofill', jsonPost({ provider: '1password' }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error).toBe('Autofill failed');
      expect(body.error).not.toContain('/var/internal/');
      expect(body.error).not.toContain('ENOENT');
    } finally {
      vault.__setVaultHas(prevHas);
      vault.__setVaultRunner(prevRunner);
      browser.close();
      cdpSrv.stop(true);
      if (savedPort === undefined) delete process.env.DUET_CHROME_PORT;
      else process.env.DUET_CHROME_PORT = savedPort;
      if (savedBin === undefined) delete process.env.DUET_CHROME_BIN;
      else process.env.DUET_CHROME_BIN = savedBin;
      if (savedOp === undefined) delete process.env.DUET_OP_CMD;
      else process.env.DUET_OP_CMD = savedOp;
      console.error = realErr;
    }
  });

  test('serveStatic sets asset cache-control, sw.js header, and blocks sibling webDir escape; compressJson uses UTF-8 byteLength', async () => {
    const origWebDir = config.webDir;
    const dir = mkdtempSync(join(tmpdir(), 'duet-static-'));
    const webDir = join(dir, 'dist');
    const siblingDir = join(dir, 'dist-secret');
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<html>ok</html>');
    writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1);');
    writeFileSync(join(webDir, 'sw.js'), '// sw');
    writeFileSync(join(siblingDir, 'leak.txt'), 'secret');
    config.webDir = webDir;
    try {
      const asset = await app('/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('immutable');

      const sw = await app('/sw.js');
      expect(sw.status).toBe(200);
      expect(sw.headers.get('service-worker-allowed')).toBe('/');

      const sibling = await app('/../dist-secret/leak.txt');
      expect(await sibling.text()).toBe('<html>ok</html>');
    } finally {
      config.webDir = origWebDir;
      rmSync(dir, { recursive: true, force: true });
    }

    // 400 four-byte UTF-8 emojis = 800 UTF-16 code units (<1024 chars), 1600 UTF-8 bytes (>=1024 bytes).
    const payload = JSON.stringify({ msg: '🚀'.repeat(400) });
    expect(payload.length).toBeLessThan(1024);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThanOrEqual(1024);
    const compressed = await compressJson(
      new Request(`${BASE}/api/items`, { headers: { 'accept-encoding': 'gzip' } }),
      Promise.resolve(new Response(payload, { headers: { 'content-type': 'application/json' } })),
    );
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('voice retry, draft upload cleanup, range serving, rate limits & doctor audio checks', () => {
  const savedEnv = {
    sttUrl: process.env.DUET_STT_URL,
    sttKey: process.env.DUET_STT_KEY,
    sttCmd: process.env.DUET_STT_CMD,
    ttsUrl: process.env.DUET_TTS_URL,
    ttsKey: process.env.DUET_TTS_KEY,
    ttsCmd: process.env.DUET_TTS_CMD,
  };
  const realFetch = globalThis.fetch;
  const realErr = console.error;

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('DUET_STT_URL', savedEnv.sttUrl);
    restore('DUET_STT_KEY', savedEnv.sttKey);
    restore('DUET_STT_CMD', savedEnv.sttCmd);
    restore('DUET_TTS_URL', savedEnv.ttsUrl);
    restore('DUET_TTS_KEY', savedEnv.ttsKey);
    restore('DUET_TTS_CMD', savedEnv.ttsCmd);
    globalThis.fetch = realFetch;
    console.error = realErr;
    resetLimits();
  });

  test('POST /api/audio/transcribe/:id handles 200, 404, 400, 405, and 503', async () => {
    process.env.DUET_STT_URL = 'http://stt.local/v1/audio/transcriptions';
    globalThis.fetch = (async () => new Response(JSON.stringify({ text: '[00:00.000 --> 00:01.000]  retried memo' }), { status: 200 })) as any;

    const memo = saveUpload({ bytes: new Uint8Array([1, 2, 3, 4]), mime: 'audio/webm', filename: 'Voice memo.webm' });
    const ok = await authed(`/api/audio/transcribe/${memo.id}`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ text: 'retried memo', attachment: { id: memo.id } });

    // video/mp4 picked as audio container is also accepted for retry transcription.
    const mp4Memo = saveUpload({ bytes: new Uint8Array([5, 6, 7, 8]), mime: 'video/mp4', filename: 'memo.mp4' });
    const okMp4 = await authed(`/api/audio/transcribe/${mp4Memo.id}`, { method: 'POST' });
    expect(okMp4.status).toBe(200);
    expect(((await okMp4.json()) as any).text).toBe('retried memo');

    // Missing attachment -> 404
    expect((await authed('/api/audio/transcribe/no-such-attachment', { method: 'POST' })).status).toBe(404);

    // Non-audio attachment -> 400
    const img = saveUpload({ bytes: new Uint8Array([9, 10]), mime: 'image/png', filename: 'photo.png' });
    const nonAudio = await authed(`/api/audio/transcribe/${img.id}`, { method: 'POST' });
    expect(nonAudio.status).toBe(400);
    expect(((await nonAudio.json()) as any).error).toContain('not audio');

    // File missing on disk -> 404
    const ghost = saveUpload({ bytes: new Uint8Array([1, 2]), mime: 'audio/ogg', filename: 'ghost.ogg' });
    rmSync(attachments.get(ghost.id)!.path, { force: true });
    expect((await authed(`/api/audio/transcribe/${ghost.id}`, { method: 'POST' })).status).toBe(404);

    // Wrong method -> 405 with Allow: POST
    const wrongMethod = await authed(`/api/audio/transcribe/${memo.id}`, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');

    // STT failure -> 503 with sanitized error and attachment preserved
    console.error = () => {};
    globalThis.fetch = (async () => new Response('upstream secret error', { status: 500 })) as any;
    const fail = await authed(`/api/audio/transcribe/${memo.id}`, { method: 'POST' });
    expect(fail.status).toBe(503);
    expect(await fail.json()).toMatchObject({ error: 'Transcription failed (500)', text: '', attachment: { id: memo.id } });
  });

  test('DELETE /api/uploads/:id deletes unlinked drafts, rejects linked (409) and missing (404)', async () => {
    const draft = saveUpload({ bytes: new Uint8Array([1, 2, 3, 4]), mime: 'audio/webm', filename: 'draft.webm' });
    const draftPath = attachments.get(draft.id)!.path;
    expect(existsSync(draftPath)).toBe(true);

    const del = await authed(`/api/uploads/${draft.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ ok: true, id: draft.id });
    expect(attachments.get(draft.id)).toBeNull();
    expect(existsSync(draftPath)).toBe(false);
    expect((await authed(`/api/uploads/${draft.id}`)).status).toBe(404);

    expect((await authed('/api/uploads/no-such-upload', { method: 'DELETE' })).status).toBe(404);

    const kept = saveUpload({ bytes: new Uint8Array([5, 6, 7]), mime: 'audio/mp4', filename: 'kept.m4a' });
    const msgRes = await authed('/api/messages', jsonPost({ text: 'here is a memo', attachment_ids: [kept.id] }));
    expect(msgRes.status).toBe(200);
    const conflict = await authed(`/api/uploads/${kept.id}`, { method: 'DELETE' });
    expect(conflict.status).toBe(409);
    expect(attachments.get(kept.id)).not.toBeNull();
    expect(existsSync(attachments.get(kept.id)!.path)).toBe(true);

    const wrong = await authed(`/api/uploads/${kept.id}`, { method: 'POST' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toContain('DELETE');
  });

  test('GET /api/uploads/:id and GET /api/brief/:id/audio support HTTP Range / 206 Partial Content and 416', async () => {
    const payload = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const audio = saveUpload({ bytes: payload, mime: 'audio/mp4', filename: 'range.m4a' });

    const full = await authed(`/api/uploads/${audio.id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('10');
    expect(Array.from(new Uint8Array(await full.arrayBuffer()))).toEqual(Array.from(payload));

    const probe = await authed(`/api/uploads/${audio.id}`, { headers: { range: 'bytes=0-1' } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get('accept-ranges')).toBe('bytes');
    expect(probe.headers.get('content-range')).toBe('bytes 0-1/10');
    expect(probe.headers.get('content-length')).toBe('2');
    expect(Array.from(new Uint8Array(await probe.arrayBuffer()))).toEqual([10, 11]);

    const openEnd = await authed(`/api/uploads/${audio.id}`, { headers: { range: 'bytes=7-' } });
    expect(openEnd.status).toBe(206);
    expect(openEnd.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(Array.from(new Uint8Array(await openEnd.arrayBuffer()))).toEqual([17, 18, 19]);

    const suffix = await authed(`/api/uploads/${audio.id}`, { headers: { range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(Array.from(new Uint8Array(await suffix.arrayBuffer()))).toEqual([17, 18, 19]);

    const clamped = await authed(`/api/uploads/${audio.id}`, { headers: { range: 'bytes=8-999' } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get('content-range')).toBe('bytes 8-9/10');
    expect(Array.from(new Uint8Array(await clamped.arrayBuffer()))).toEqual([18, 19]);

    for (const badRange of ['bytes=10-12', 'bytes=6-2', 'bytes=-0', 'bytes=abc-def']) {
      const r = await authed(`/api/uploads/${audio.id}`, { headers: { range: badRange } });
      expect(r.status).toBe(416);
      expect(r.headers.get('content-range')).toBe('bytes */10');
    }

    // Brief audio route + Range support
    const briefId = newId();
    const now = Date.now();
    items.save({
      id: briefId,
      kind: 'card',
      channel_id: GENERAL_CHANNEL,
      created_at: now,
      updated_at: now,
      card: { type: 'brief', title: `Brief audio range test ${briefId}`, status: 'info' },
    });
    delete process.env.DUET_TTS_CMD;
    process.env.DUET_TTS_URL = 'http://tts.local/v1/audio/speech';
    const mp3Bytes = new Uint8Array([100, 101, 102, 103, 104, 105, 106, 107]);
    globalThis.fetch = (async () => new Response(mp3Bytes, { status: 200 })) as any;

    expect((await authed('/api/brief/no-such-brief/audio')).status).toBe(404);

    const briefFull = await authed(`/api/brief/${briefId}/audio`);
    expect(briefFull.status).toBe(200);
    expect(briefFull.headers.get('content-type')).toBe('audio/mpeg');
    expect(briefFull.headers.get('accept-ranges')).toBe('bytes');
    expect(Array.from(new Uint8Array(await briefFull.arrayBuffer()))).toEqual(Array.from(mp3Bytes));

    const briefPart = await authed(`/api/brief/${briefId}/audio`, { headers: { range: 'bytes=2-5' } });
    expect(briefPart.status).toBe(206);
    expect(briefPart.headers.get('content-range')).toBe('bytes 2-5/8');
    expect(briefPart.headers.get('content-length')).toBe('4');
    expect(Array.from(new Uint8Array(await briefPart.arrayBuffer()))).toEqual([102, 103, 104, 105]);

    const briefOor = await authed(`/api/brief/${briefId}/audio`, { headers: { range: 'bytes=50-60' } });
    expect(briefOor.status).toBe(416);
    expect(briefOor.headers.get('content-range')).toBe('bytes */8');
  });

  test('per-device rate limits apply to uploads, transcribe, transcribe/:id, and brief audio', async () => {
    resetLimits();
    process.env.DUET_STT_URL = 'http://stt.local/v1/audio/transcriptions';
    process.env.DUET_TTS_URL = 'http://tts.local/v1/audio/speech';
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('tts')) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    }) as any;

    // 1. POST /api/uploads (limit 30/min)
    for (let i = 0; i < 30; i++) {
      const form = new FormData();
      form.set('file', new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' }));
      expect((await authed('/api/uploads', { method: 'POST', body: form })).status).toBe(200);
    }
    const up429 = await authed('/api/uploads', { method: 'POST', body: new FormData() });
    expect(up429.status).toBe(429);
    expect(((await up429.json()) as any).code).toBe('too_many');

    // 2. POST /api/audio/transcribe and POST /api/audio/transcribe/:id share transcribe limit (20/min)
    resetLimits();
    const memo = saveUpload({ bytes: new Uint8Array([1, 2]), mime: 'audio/webm', filename: 'r.webm' });
    for (let i = 0; i < 19; i++) {
      expect((await authed(`/api/audio/transcribe/${memo.id}`, { method: 'POST' })).status).toBe(200);
    }
    expect((await authed('/api/audio/transcribe', { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1, 2]) })).status).toBe(200);
    const stt429 = await authed(`/api/audio/transcribe/${memo.id}`, { method: 'POST' });
    expect(stt429.status).toBe(429);
    expect(stt429.headers.get('retry-after')).toBeTruthy();

    // 3. GET /api/brief/:id/audio (limit 30/min)
    resetLimits();
    const briefId = newId();
    const now = Date.now();
    items.save({
      id: briefId,
      kind: 'card',
      channel_id: GENERAL_CHANNEL,
      created_at: now,
      updated_at: now,
      card: { type: 'brief', title: `Rate limit brief ${briefId}`, status: 'info' },
    });
    for (let i = 0; i < 30; i++) {
      expect((await authed(`/api/brief/${briefId}/audio`)).status).toBe(200);
    }
    const brief429 = await authed(`/api/brief/${briefId}/audio`);
    expect(brief429.status).toBe(429);
    expect(((await brief429.json()) as any).code).toBe('too_many');
  });

  test('doctor() reports STT, TTS, and ffmpeg diagnostics without leaking API keys', async () => {
    process.env.DUET_STT_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
    process.env.DUET_STT_KEY = 'super-secret-stt-key';
    process.env.DUET_TTS_URL = 'https://api.openai.com/v1/audio/speech';
    process.env.DUET_TTS_KEY = 'super-secret-tts-key';

    const res = await handleInternal(
      new Request(`${INTERNAL_BASE}/internal/doctor`, {
        headers: { authorization: `Bearer ${internalToken()}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: { name: string; ok: boolean; detail: string; info?: boolean }[] };
    const text = JSON.stringify(body);
    expect(text).not.toContain('super-secret-stt-key');
    expect(text).not.toContain('super-secret-tts-key');
    expect(body.checks.find((c) => c.name === 'speech-to-text (STT)')).toMatchObject({ ok: true });
    expect(body.checks.find((c) => c.name === 'text-to-speech (TTS)')).toMatchObject({ ok: true });
    expect(body.checks.find((c) => c.name === 'ffmpeg (audio transcoding)')).toBeDefined();
  });
});
