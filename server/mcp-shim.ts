#!/usr/bin/env npx tsx
// Minimal stdio MCP server that Hermes spawns. It holds no state: every tool call is
// forwarded to the Hermes Duet server's loopback-only internal API.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools';

const dataDir = process.env.DUET_DATA_DIR ?? join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const base = `http://127.0.0.1:${process.env.DUET_INTERNAL_PORT ?? 7457}`;

function token() {
  // Read on every call so a server restart that rotates nothing still works, and a
  // missing file (server never started) becomes a clear tool error instead of a crash.
  return readFileSync(join(dataDir, 'internal.token'), 'utf8').trim();
}

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callTool(name: string, args: unknown) {
  try {
    const res = await fetch(`${base}/internal/tool/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
      body: JSON.stringify({ args: args ?? {} }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) return { content: [{ type: 'text', text: body.error ?? `Hermes Duet returned ${res.status}` }], isError: true };
    return { content: [{ type: 'text', text: body.text ?? 'ok' }] };
  } catch (e: any) {
    return { content: [{ type: 'text', text: `Hermes Duet is not reachable (${e?.message ?? e}). Tell the user in plain text instead.` }], isError: true };
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg;
  const reply = (result: unknown) => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  if (typeof method !== 'string' || !method) return fail(-32600, 'Invalid Request');
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hermes-duet', version: '0.2.0' },
        instructions:
          'Hermes Duet is the phone app the user talks to you through. Use these tools to put approvals, questions, briefs, checklists, dashboards, files and task progress in front of them.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call':
      return reply(await callTool(params?.name, params?.arguments));
    default:
      if (method.startsWith('notifications/')) return;
      return fail(-32601, `Method not found: ${method}`);
  }
}

let buf = '';
let inflight = 0;
let ended = false;

function dispatchLine(rawLine: string) {
  const line = rawLine.trim();
  if (!line) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const items = Array.isArray(msg) ? msg : [msg];
  if (Array.isArray(msg) && items.length === 0) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  for (const m of items) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    inflight++;
    handle(m)
      .catch((e) => m?.id !== undefined && send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } }))
      .finally(() => {
        inflight--;
        if (ended && inflight === 0) process.exit(0);
      });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    dispatchLine(line);
  }
});
process.stdin.on('end', () => {
  if (buf.trim()) {
    const tail = buf;
    buf = '';
    dispatchLine(tail);
  }
  ended = true;
  if (inflight === 0) process.exit(0);
});
