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
  let ping: ReturnType<typeof setInterval>;
  const stream = new ReadableStream({
    start(ctrl) {
      sink = (chunk) => {
        try {
          ctrl.enqueue(enc.encode(chunk));
        } catch {
          sinks.delete(sink);
        }
      };
      sinks.add(sink);
      sink(`retry: 3000\n\ndata: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`);
      // Comment pings keep proxies (Cloudflare closes idle streams at ~100s) from dropping us.
      ping = setInterval(() => sink(': ping\n\n'), 25_000);
      req.signal.addEventListener('abort', () => {
        clearInterval(ping);
        sinks.delete(sink);
        try {
          ctrl.close();
        } catch {}
      });
    },
    cancel() {
      clearInterval(ping);
      sinks.delete(sink);
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
