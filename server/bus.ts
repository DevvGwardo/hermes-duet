import type { ServerEvent } from '../shared/types';

type Sink = (chunk: string) => void;
const sinks = new Set<Sink>();
const enc = new TextEncoder();

export function broadcast(ev: ServerEvent) {
  const chunk = `data: ${JSON.stringify(ev)}\n\n`;
  for (const s of sinks) s(chunk);
}

/** An SSE response that receives every broadcast until the client goes away. */
export function sseResponse(req: Request): Response {
  let sink: Sink;
  let ping: ReturnType<typeof setInterval> | null = null;
  let onAbort: (() => void) | null = null;
  const cleanup = (ctrl?: ReadableStreamDefaultController<Uint8Array>) => {
    if (ping) {
      clearInterval(ping);
      ping = null;
    }
    if (sink) sinks.delete(sink);
    if (onAbort) {
      req.signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
    if (ctrl) {
      try {
        ctrl.close();
      } catch {}
    }
  };
  const stream = new ReadableStream({
    start(ctrl) {
      if (req.signal.aborted) {
        try {
          ctrl.close();
        } catch {}
        return;
      }
      sink = (chunk) => {
        // A stalled client must not grow the stream buffer without bound. At 64 queued chunks, drop the sink and let
        // EventSource reconnect: the client takes a fresh snapshot, exactly like the live-browser frame path.
        if (typeof ctrl.desiredSize === 'number' && ctrl.desiredSize < -64) {
          cleanup(ctrl);
          return;
        }
        try {
          ctrl.enqueue(enc.encode(chunk));
        } catch {
          cleanup(ctrl);
        }
      };
      sinks.add(sink);
      sink(`retry: 3000\n\ndata: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
      if (req.signal.aborted || !sinks.has(sink)) {
        cleanup(ctrl);
        return;
      }
      // Comment pings keep proxies (Cloudflare closes idle streams at ~100s) from dropping us.
      ping = setInterval(() => sink(': ping\n\n'), 25_000);
      onAbort = () => cleanup(ctrl);
      req.signal.addEventListener('abort', onAbort, { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export function clientCount() {
  return sinks.size;
}
