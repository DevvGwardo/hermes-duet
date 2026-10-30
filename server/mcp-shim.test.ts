// Contract test for the MCP shim: Hermes spawns it as `duet`, so the tools it advertises and the internal route it
// forwards to are the agent's whole API surface. Drift here breaks tools silently, with nothing else to notice it.
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS } from './tools';

/** Read JSON-RPC replies from the shim's stdout until `count` have arrived (or the test times out). */
async function replies(stream: ReadableStream<Uint8Array>, count: number): Promise<any[]> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const out: any[] = [];
  let buf = '';
  const deadline = Date.now() + 5000;
  while (out.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) out.push(JSON.parse(line));
    }
  }
  return out;
}

test('the shim advertises exactly the tools and forwards each call to the internal route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-shim-'));
  writeFileSync(join(dir, 'internal.token'), 'shim-test-token', { mode: 0o600 });

  const calls: { path: string; auth: string; args: any }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as any;
      calls.push({ path: url.pathname, auth: req.headers.get('authorization') ?? '', args: body?.args });
      return Response.json({ text: 'posted from the server' });
    },
  });

  const proc = Bun.spawn(['bun', join(import.meta.dir, 'mcp-shim.ts')], {
    env: { ...process.env, DUET_DATA_DIR: dir, DUET_INTERNAL_PORT: String(server.port) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });

  try {
    const reply = replies(proc.stdout, 3);
    const send = (msg: unknown) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_approval', arguments: { title: 'Send it' } } });

    const [init, list, call] = await reply;
    expect(init.result.serverInfo.name).toBe('hermes-duet');
    // Exactly what tools.ts declares: no more, no fewer, so a tool added there without a shim route is caught here.
    expect(list.result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(call.result.content[0].text).toBe('posted from the server');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/internal/tool/request_approval');
    expect(calls[0]!.auth).toBe('Bearer shim-test-token');
    expect(calls[0]!.args).toEqual({ title: 'Send it' });
  } finally {
    proc.kill();
    server.stop(true);
  }
});

test('a failed tool call comes back as an error the model can read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-shim-'));
  writeFileSync(join(dir, 'internal.token'), 'shim-test-token', { mode: 0o600 });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ error: 'missing title' }, { status: 400 }),
  });
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'mcp-shim.ts')], {
    env: { ...process.env, DUET_DATA_DIR: dir, DUET_INTERNAL_PORT: String(server.port) },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  try {
    const reply = replies(proc.stdout, 1);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: {} } })}\n`);
    const [call] = await reply;
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toBe('missing title');
  } finally {
    proc.kill();
    server.stop(true);
  }
});
