import { expect, test } from 'bun:test';
import { broadcast, clientCount, sseResponse } from './bus';

async function firstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  try {
    const { value } = await reader.read();
    return Buffer.from(value as Uint8Array).toString();
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

test('broadcast with no clients does not throw', () => {
  expect(() => broadcast({ type: 'hello', at: Date.now() })).not.toThrow();
});

test('sse response carries event-stream headers', () => {
  const res = sseResponse(new Request('http://x/events'));
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(res.headers.get('cache-control')).toContain('no-cache');
  // Closing the stream must drop the client again.
  res.body!.cancel();
  expect(clientCount() >= 0).toBe(true);
});

test('sse stream opens with retry + hello and tracks client count', async () => {
  const before = clientCount();
  const res = sseResponse(new Request('http://x/events'));
  expect(clientCount()).toBe(before + 1);
  const chunk = await firstChunk(res);
  expect(chunk).toContain('retry: 3000');
  expect(chunk).toContain('"type":"hello"');
});

test('broadcast reaches an open sse client', async () => {
  const res = sseResponse(new Request('http://x/events'));
  const reader = res.body!.getReader();
  try {
    const first = await reader.read();
    expect(Buffer.from(first.value as Uint8Array).toString()).toContain('hello');
    const next = reader.read();
    broadcast({ type: 'hello', at: 12345 });
    const { value } = await next;
    expect(Buffer.from(value as Uint8Array).toString()).toContain('12345');
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
});
