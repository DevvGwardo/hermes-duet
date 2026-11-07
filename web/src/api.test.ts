// api.ts touches document/window at import (presence + SSE wiring), so stub the
// DOM surface first, then import dynamically. Stubs stay process-local to this file.
import { expect, test } from 'bun:test';

(globalThis as any).document = { addEventListener() {}, visibilityState: 'hidden' };
(globalThis as any).window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { api, loadOlder, loadUntil, openChannel } = await import('./api');
const { getState, hasMoreFor, setState } = await import('./store');

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
