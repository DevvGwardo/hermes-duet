// api.ts touches document/window at import (presence + SSE wiring), so stub the
// DOM surface first, then import dynamically. Stubs stay process-local to this file.
import { expect, test } from 'bun:test';

(globalThis as any).document = { addEventListener() {}, visibilityState: 'hidden' };
(globalThis as any).window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };

const { api } = await import('./api');
const { getState, setState } = await import('./store');

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
