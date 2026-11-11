import { expect, test } from 'bun:test';
import { HermesError, hermes } from './hermes';

function stubFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as any;
  return { calls, restore: () => void (globalThis.fetch = real) };
}
const ok = (json: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });

test('health is true when the gateway answers, false when it is unreachable', async () => {
  const up = stubFetch(() => ok({}));
  try {
    expect(await hermes.health()).toBe(true);
    expect(up.calls[0].url).toMatch(/\/health$/);
  } finally {
    up.restore();
  }
  const down = stubFetch(() => {
    throw new Error('refused');
  });
  try {
    expect(await hermes.health()).toBe(false);
  } finally {
    down.restore();
  }
});

test('starting a run posts to /v1/runs with the idempotency key', async () => {
  const s = stubFetch(() => ok({ run_id: 'r1', status: 'queued' }));
  try {
    const r = await hermes.startRun({ input: 'hi', session_id: 's1', instructions: 'be brief', idempotencyKey: 'idem-1' });
    expect(r).toEqual({ run_id: 'r1', status: 'queued' });
    expect(s.calls[0].url).toMatch(/\/v1\/runs$/);
    expect(s.calls[0].init.method).toBe('POST');
    expect(s.calls[0].init.headers['idempotency-key']).toBe('idem-1');
    expect(s.calls[0].init.headers.authorization).toMatch(/^Bearer /);
    const body = JSON.parse(s.calls[0].init.body);
    expect(body.session_id).toBe('s1');
  } finally {
    s.restore();
  }
});

test('a refused run raises HermesError with status and the gateway message', async () => {
  const s = stubFetch(() => ({ ok: false, status: 401, text: async () => '{"error":{"message":"bad key"}}' }));
  try {
    const err = await hermes.startRun({ input: 'hi', session_id: 's1', instructions: 'x', idempotencyKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(HermesError);
    expect(err.status).toBe(401);
    expect(err.message).toContain('bad key');
  } finally {
    s.restore();
  }
  const badAuth = stubFetch(() => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
  try {
    expect(await hermes.checkAuth()).toBe(false);
  } finally {
    badAuth.restore();
  }
});

test('a non-JSON refusal still raises instead of crashing the parser', async () => {
  const s = stubFetch(() => ({ ok: false, status: 500, text: async () => '<html>down</html>' }));
  try {
    const err = await hermes.startRun({ input: 'hi', session_id: 's1', instructions: 'x', idempotencyKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(HermesError);
    expect(err.status).toBe(500);
  } finally {
    s.restore();
  }
});

test('events() flushes split UTF-8 sequences and delivers a trailing EOF frame without a double newline', async () => {
  const enc = new TextEncoder();
  const multi = enc.encode('{"event":"message.delta","delta":"€🚀"}');
  // Split right inside the multi-byte UTF-8 sequence AND omit trailing \n\n before closing the stream.
  const firstFramePrefix = enc.encode('id: 1\ndata: ');
  const splitPoint = Math.floor(multi.length / 2) + 1;
  const part1 = new Uint8Array(firstFramePrefix.length + splitPoint);
  part1.set(firstFramePrefix);
  part1.set(multi.slice(0, splitPoint), firstFramePrefix.length);
  const tailPart1 = multi.slice(splitPoint);
  const part2 = new Uint8Array(tailPart1.length + enc.encode('\n\nid: 2\ndata: {"event":"run.completed"}').length);
  part2.set(tailPart1);
  part2.set(enc.encode('\n\nid: 2\ndata: {"event":"run.completed"}'), tailPart1.length);

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(part1);
      ctrl.enqueue(part2);
      ctrl.close();
    },
  });
  const s = stubFetch(() => ({ ok: true, status: 200, body: stream }));
  const got: any[] = [];
  try {
    await hermes.events('r-sse-eof', 0, (ev) => got.push(ev), new AbortController().signal);
    expect(got).toEqual([
      { event: 'message.delta', delta: '€🚀', seq: 1 },
      { event: 'run.completed', seq: 2 },
    ]);
  } finally {
    s.restore();
  }
});
