// api.ts touches document/window at import (presence + SSE wiring), so stub the
// DOM surface first, then import dynamically. Stubs stay process-local to this file.
import { expect, test } from 'bun:test';

(globalThis as any).document = { addEventListener() {}, visibilityState: 'hidden' };
(globalThis as any).window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { api, connect, loadOlder, loadUntil, openChannel } = await import('./api');
const { channelItems, getState, hasMoreFor, setState } = await import('./store');

const CHANNELS = [
  { id: 'chan-general', slug: 'general' } as any,
  { id: 'chan-taxes', slug: 'taxes' } as any,
];

test('exhausting one channel leaves Earlier messages on for the other (per-channel has_more)', async () => {
  // The original GAPS bug: one global hasMore meant paging #general to its end hid the button in
  // #taxes, which still had history. loadOlder on general must only touch general's entry.
  const real = api.older;
  (api as any).older = async () => ({ items: [], has_more: false });
  try {
    setState({
      channelId: 'chan-general',
      channels: CHANNELS,
      hasMoreBy: { 'chan-general': true, 'chan-taxes': true },
      items: [
        { id: 'general-old', channel_id: 'chan-general', created_at: 10 } as any,
        { id: 'taxes-mid', channel_id: 'chan-taxes', created_at: 100 } as any,
      ],
    });
    await loadOlder();
    expect(getState().hasMoreBy['chan-general']).toBe(false);
    expect(getState().hasMoreBy['chan-taxes']).toBe(true);
    setState({ channelId: 'chan-taxes' });
    expect(hasMoreFor(getState())).toBe(true);
    setState({ channelId: 'chan-general' });
    expect(hasMoreFor(getState())).toBe(false);
  } finally {
    (api as any).older = real;
  }
});

test('openChannel records the fetched page\'s has_more for that channel', async () => {
  // channelPage's has_more used to be discarded on the floor; the channel's real state stayed
  // whatever the snapshot guessed.
  const real = { channelPage: api.channelPage, seenChannel: api.seenChannel };
  (api as any).channelPage = async () => ({ items: [{ id: 'tax-9', channel_id: 'chan-taxes', created_at: 400 } as any], has_more: true });
  (api as any).seenChannel = async () => ({ ok: true });
  try {
    setState({ channelId: 'chan-general', channels: CHANNELS, hasMoreBy: { 'chan-general': true }, items: [] });
    await openChannel('chan-taxes');
    expect(getState().hasMoreBy['chan-taxes']).toBe(true);
  } finally {
    (api as any).channelPage = real.channelPage;
    (api as any).seenChannel = real.seenChannel;
  }
});

test('loadUntil pages only while the open channel has more, not any other', async () => {
  const real = api.older;
  const asked: string[] = [];
  (api as any).older = async (before: string) => {
    asked.push(before);
    return { items: [], has_more: false };
  };
  try {
    // Taxes exhausted, general not: jumping to an id inside general pages via general's cursor.
    setState({
      channelId: 'chan-general',
      channels: CHANNELS,
      hasMoreBy: { 'chan-general': true, 'chan-taxes': false },
      items: [{ id: 'general-old', channel_id: 'chan-general', created_at: 10 } as any],
    });
    await loadUntil('missing-id', 3);
    expect(asked).toEqual(['general-old']);

    // Open channel exhausted: no fetch at all, even though taxes still has more.
    asked.length = 0;
    setState({ channelId: 'chan-taxes', hasMoreBy: { 'chan-general': true, 'chan-taxes': false } });
    await loadUntil('missing-id', 3);
    expect(asked).toEqual([]);
  } finally {
    (api as any).older = real;
  }
});

function stubFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
const ok = (json: any) => ({ status: 200, ok: true, statusText: 'OK', text: async () => JSON.stringify(json), json: async () => json });

test('send posts the text with the open channel, and no attachment key when empty', async () => {
  const s = stubFetch(() => ok({ item: { id: 'm1' } }));
  try {
    setState({ channelId: 'general', authed: true });
    await api.send('hello');
    expect(s.calls[0].url).toBe('/api/messages');
    expect(s.calls[0].init.method).toBe('POST');
    expect(s.calls[0].init.credentials).toBe('include');
    expect(JSON.parse(s.calls[0].init.body)).toEqual({ text: 'hello', channel_id: 'general' });
  } finally {
    s.restore();
  }
});

test('attachments ride along only when provided, for messages and tasks', async () => {
  const s = stubFetch(() => ok({ item: { id: 'm2' }, task: { id: 't1' } }));
  try {
    setState({ channelId: 'c9', authed: true });
    await api.send('see this', ['a1', 'a2']);
    expect(JSON.parse(s.calls[0].init.body)).toEqual({ text: 'see this', channel_id: 'c9', attachment_ids: ['a1', 'a2'] });
    await api.startTask('build it', ['a1']);
    expect(s.calls[1].url).toBe('/api/tasks');
    expect(JSON.parse(s.calls[1].init.body)).toEqual({ text: 'build it', channel_id: 'c9', attachment_ids: ['a1'] });
  } finally {
    s.restore();
  }
});

test('older pages with before + channel, encoded', async () => {
  const s = stubFetch(() => ok({ items: [], has_more: false }));
  try {
    await api.older('id with spaces', 'taxes & co');
    expect(s.calls[0].url).toBe('/api/items?before=id%20with%20spaces&channel=taxes%20%26%20co');
    await api.older('abc');
    expect(s.calls[1].url).toBe('/api/items?before=abc');
  } finally {
    s.restore();
  }
});

test('loadOlder pages back from the oldest item in the open channel, not the whole install', async () => {
  // The thread keeps every channel's items in one list. After paging #general, its oldest item is the globally
  // oldest, so using it as the cursor for #taxes asks for a window that contains none of #taxes' unloaded history.
  const seen: [string, string | undefined][] = [];
  const realOlder = api.older;
  (api as any).older = async (before: string, channel?: string) => {
    seen.push([before, channel]);
    return { items: [], has_more: false };
  };
  try {
    setState({
      channelId: 'chan-taxes',
      hasMoreBy: { 'chan-taxes': true },
      channels: [
        { id: 'chan-general', slug: 'general' } as any,
        { id: 'chan-taxes', slug: 'taxes' } as any,
      ],
      items: [
        { id: 'general-old', channel_id: 'chan-general', created_at: 10 } as any,
        { id: 'taxes-mid', channel_id: 'chan-taxes', created_at: 100 } as any,
      ],
    });
    await loadOlder();
    expect(seen).toEqual([['taxes-mid', 'chan-taxes']]);
  } finally {
    (api as any).older = realOlder;
  }
});

test('openChannel loads a channel the snapshot has no items for, even with a pre-channels item loaded', async () => {
  // Rows written before topic channels carry no `channel_id` inside their JSON (the column is backfilled, the item
  // is not). Reading the target id as the fallback makes every such row look like it belongs to the channel being
  // opened, so the page is never fetched and the channel shows empty for good.
  const asked: string[] = [];
  const real = { channelPage: api.channelPage, seenChannel: api.seenChannel };
  (api as any).channelPage = async (id: string) => {
    asked.push(id);
    return { items: [{ id: 'tax-1', channel_id: id, created_at: 500 } as any], has_more: true };
  };
  (api as any).seenChannel = async () => ({ ok: true });
  try {
    setState({
      channelId: 'chan-general',
      channels: [
        { id: 'chan-general', slug: 'general' } as any,
        { id: 'chan-taxes', slug: 'taxes' } as any,
      ],
      items: [{ id: 'legacy-1', created_at: 10 } as any],
    });
    await openChannel('chan-taxes');
    expect(asked).toEqual(['chan-taxes']);
    expect(getState().items.map((i) => i.id)).toContain('tax-1');
  } finally {
    (api as any).channelPage = real.channelPage;
    (api as any).seenChannel = real.seenChannel;
  }
});

test('a 401 unpairs the app and reports not paired', async () => {
  const s = stubFetch(() => ({ status: 401, ok: false, statusText: 'Unauthorized', text: async () => '', json: async () => ({}) }));
  try {
    setState({ authed: null, ready: false });
    const err = await api.snapshot().catch((e) => e);
    expect(err.status).toBe(401);
    expect(getState().authed).toBe(false);
    expect(getState().ready).toBe(true);
  } finally {
    s.restore();
  }
});

test('a failed call surfaces the server error message and status', async () => {
  const s = stubFetch(() => ({ status: 500, ok: false, statusText: 'Bad Gateway', text: async () => '{"error":"boom"}', json: async () => ({}) }));
  try {
    const err = await api.stop().catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toBe('boom');
  } finally {
    s.restore();
  }
});

test('saveFileVersion posts the edited text to the version route', async () => {
  const s = stubFetch(() => ok({ file: { id: 'v2', version_of: 'v1' } }));
  try {
    const res = await api.saveFileVersion('v1', '# Edited');
    expect(s.calls[0].url).toBe('/api/files/v1/versions');
    expect(s.calls[0].init.method).toBe('POST');
    expect(s.calls[0].init.credentials).toBe('include');
    expect(JSON.parse(s.calls[0].init.body)).toEqual({ text: '# Edited' });
    expect(res.file.version_of).toBe('v1');
  } finally {
    s.restore();
  }
});

test('api.item and api.fileMeta hit the single-record lookup routes', async () => {
  const s = stubFetch((url) => {
    if (url.startsWith('/api/items/')) return ok({ item: { id: 'it-1' } });
    return ok({ file: { id: 'f-1' } });
  });
  try {
    const itemRes = await api.item('it 1');
    const fileRes = await api.fileMeta('f/1');
    expect(s.calls.map((c) => c.url)).toEqual(['/api/items/it%201', '/api/files/f%2F1/meta']);
    expect(itemRes.item.id).toBe('it-1');
    expect(fileRes.file.id).toBe('f-1');
  } finally {
    s.restore();
  }
});

test('api.transcribe preserves the saved voice memo on 503 when attachment is returned', async () => {
  const memo = { id: 'att-1', name: 'Voice memo', mime: 'audio/webm', size: 12, kind: 'audio', created_at: 1 };
  const s = stubFetch(() => ({
    status: 503,
    ok: false,
    statusText: 'Service Unavailable',
    text: async () => '',
    json: async () => ({ error: 'whisper missing', attachment: memo, text: '' }),
  }));
  try {
    const res = await api.transcribe(new Blob(['audio'], { type: 'audio/mp4' }), 'audio/mp4');
    expect(s.calls[0].url).toBe('/api/audio/transcribe');
    expect(s.calls[0].init.headers['content-type']).toBe('audio/mp4');
    expect(res).toEqual({ text: '', attachment: memo as any, error: 'whisper missing' });
  } finally {
    s.restore();
  }
});

test('api.retryTranscribe posts to /api/audio/transcribe/:id and handles 200 and 503', async () => {
  const memo = { id: 'att/1', name: 'Voice memo', mime: 'audio/mp4', size: 20, kind: 'audio', created_at: 1 };
  let mode: 'ok' | '503' = 'ok';
  const s = stubFetch(() =>
    mode === 'ok'
      ? ok({ text: 'hello world', attachment: memo })
      : {
          status: 503,
          ok: false,
          statusText: 'Service Unavailable',
          text: async () => '',
          json: async () => ({ error: 'still unavailable', attachment: memo, text: '' }),
        },
  );
  try {
    const okRes = await api.retryTranscribe('att/1');
    expect(s.calls[0].url).toBe('/api/audio/transcribe/att%2F1');
    expect(s.calls[0].init.method).toBe('POST');
    expect(s.calls[0].init.credentials).toBe('include');
    expect(okRes).toEqual({ text: 'hello world', attachment: memo as any });

    mode = '503';
    const failRes = await api.retryTranscribe('att/1');
    expect(failRes).toEqual({ text: '', attachment: memo as any, error: 'still unavailable' });
  } finally {
    s.restore();
  }
});

test('api.deleteUpload calls DELETE /api/uploads/:id and swallows 404/409 gracefully', async () => {
  let status = 200;
  const s = stubFetch(() => {
    if (status === 200) return ok({ ok: true });
    return {
      status,
      ok: false,
      statusText: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'Server Error',
      text: async () => JSON.stringify({ error: 'boom' }),
      json: async () => ({ error: 'boom' }),
    };
  });
  try {
    expect(await api.deleteUpload('up 1')).toEqual({ ok: true });
    expect(s.calls[0].url).toBe('/api/uploads/up%201');
    expect(s.calls[0].init.method).toBe('DELETE');
    expect(s.calls[0].init.credentials).toBe('include');

    status = 404;
    expect(await api.deleteUpload('up-missing')).toEqual({ ok: false });

    status = 409;
    expect(await api.deleteUpload('up-linked')).toEqual({ ok: false });

    status = 500;
    const err = await api.deleteUpload('up-err').catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toBe('boom');
  } finally {
    s.restore();
  }
});

test('openChannel clamps seen_at to last_at for clock skew and records errors on failure', async () => {
  const real = { channelPage: api.channelPage, seenChannel: api.seenChannel };
  const future = Date.now() + 300_000;
  (api as any).seenChannel = async () => ({ ok: true });
  (api as any).channelPage = async () => {
    throw new Error('offline');
  };
  try {
    setState({
      channelId: 'chan-general',
      channels: [
        { id: 'chan-general', slug: 'general' } as any,
        { id: 'chan-taxes', slug: 'taxes', last_at: future, seen_at: 0 } as any,
      ],
      items: [],
      channelLoading: {},
      channelError: {},
    });
    const err = await openChannel('chan-taxes').catch((e) => e);
    expect(err.message).toBe('offline');
    const c = getState().channels.find((x) => x.id === 'chan-taxes')!;
    expect(c.seen_at).toBeGreaterThanOrEqual(future);
    expect(getState().channelLoading['chan-taxes']).toBe(false);
    expect(getState().channelError['chan-taxes']).toBe('offline');
  } finally {
    (api as any).channelPage = real.channelPage;
    (api as any).seenChannel = real.seenChannel;
  }
});

test('loadOlder returns false immediately when channel is empty or yields no unseen items (loadUntil does not spin)', async () => {
  const realOlder = api.older;
  let calls = 0;
  (api as any).older = async () => {
    calls++;
    // Simulate stale cursor/server keeping has_more: true while returning no new items.
    return { items: [{ id: 'existing-1', channel_id: 'chan-taxes', created_at: 100 }], has_more: true };
  };
  try {
    // 1) Empty open channel: loadOlder returns false with zero API calls, loadUntil stops immediately.
    setState({
      channelId: 'chan-taxes',
      channels: CHANNELS,
      hasMoreBy: { 'chan-taxes': true },
      items: [],
    });
    expect(await loadOlder()).toBe(false);
    await loadUntil('target', 10);
    expect(calls).toBe(0);

    // 2) No new items returned even with has_more: true -> loadUntil exits after 1 probe instead of 10.
    setState({
      items: [{ id: 'existing-1', channel_id: 'chan-taxes', created_at: 100 } as any],
    });
    await loadUntil('missing-id', 10);
    expect(calls).toBe(1);
  } finally {
    (api as any).older = realOlder;
  }
});

test('connect refetches empty active channel on reconnect and deduplicates reconnect timers', async () => {
  const realES = (globalThis as any).EventSource;
  const instances: any[] = [];
  class FakeEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((m: any) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(public url: string) {
      instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  (globalThis as any).EventSource = FakeEventSource;

  let failSnap = true;
  const scheduled: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextTid = 1000;
  const byId = new Map<number, { fn: () => void; ms: number; cleared: boolean }>();
  (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
    const rec = { fn, ms, cleared: false };
    const id = nextTid++;
    scheduled.push(rec);
    byId.set(id, rec);
    return id;
  };
  (globalThis as any).clearTimeout = (id: number) => {
    const rec = byId.get(id);
    if (rec) rec.cleared = true;
  };

  let snapReq = 0;
  const pageCalls: string[] = [];
  const s = stubFetch((url) => {
    if (url === '/api/state') {
      snapReq++;
      if (failSnap) {
        return { status: 503, ok: false, statusText: 'Down', text: async () => 'down', json: async () => ({}) };
      }
      // Snapshot returns items only in general, leaving active channel #chan-taxes empty.
      return ok({
        items: [{ id: 'g-1', channel_id: 'chan-general', created_at: 10, updated_at: 10 }],
        has_more: false,
        pending: [],
        tasks: [],
        files: [],
        pages: [],
        channels: CHANNELS,
        settings: { brief_enabled: true, brief_time: '07:30', checkins: 'off', quiet_start: '22:00', quiet_end: '07:00', timezone: 'UTC' },
        agent: { busy: false, current_run: null, queued: 0, hermes: 'ok', background_running: 0 },
        push_enabled: false,
      });
    }
    if (url === '/api/channels/chan-taxes/items') {
      pageCalls.push(url);
      return ok({
        items: [{ id: 'tax-older', channel_id: 'chan-taxes', created_at: 5, updated_at: 5 }],
        has_more: true,
      });
    }
    return ok({ ok: true });
  });

  try {
    setState({ channelId: 'chan-taxes', channels: CHANNELS, items: [] });

    // Trigger reconnect failure and second overlapping trigger; old pending timer should be cleared cleanly.
    await connect();
    expect(scheduled).toHaveLength(1);
    expect(scheduled.filter((t) => !t.cleared)).toHaveLength(1);
    await connect();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].cleared).toBe(true);
    expect(scheduled.filter((t) => !t.cleared)).toHaveLength(1);

    // Succeed snapshot while active channel is chan-taxes (not in global snapshot) -> must fetch channelPage.
    failSnap = false;
    await connect();
    expect(snapReq).toBe(3);
    expect(pageCalls).toEqual(['/api/channels/chan-taxes/items']);
    expect(channelItems(getState()).map((i) => i.id)).toEqual(['tax-older']);
    expect(getState().hasMoreBy['chan-taxes']).toBe(true);
    // Reconnect timer should be cleared by connect() entry/open and EventSource opened cleanly.
    expect(scheduled.every((t) => t.cleared)).toBe(true);
    expect(instances).toHaveLength(1);
    instances[0].onopen?.();
    expect(getState().connected).toBe(true);

    // Stream error schedules exactly one reconnect timer even if onerror fires twice, and next connect clears it.
    instances[0].onerror?.();
    instances[0].onerror?.();
    expect(scheduled).toHaveLength(3);
    expect(scheduled.filter((t) => !t.cleared)).toHaveLength(1);
    await connect();
    expect(scheduled.every((t) => t.cleared)).toBe(true);
    instances[1].onopen?.();
    expect(getState().connected).toBe(true);
  } finally {
    for (const esInst of instances) esInst.close();
    (globalThis as any).EventSource = realES;
    (globalThis as any).setTimeout = realSetTimeout;
    (globalThis as any).clearTimeout = realClearTimeout;
    s.restore();
  }
});
