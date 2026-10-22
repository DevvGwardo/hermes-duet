#!/usr/bin/env bun
// Minimal stdio MCP server that Hermes spawns. It holds no state: every tool call is
// forwarded to the Hermes Duet server's loopback-only internal API.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TOOLS } from './tools';

const dataDir = process.env.DUET_DATA_DIR ?? join(resolve(import.meta.dir, '..'), 'data');
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
      if (method?.startsWith('notifications/')) return;
      return fail(-32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      inflight++;
      handle(m)
        .catch((e) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e) } }))
        .finally(() => {
          inflight--;
          if (ended && inflight === 0) process.exit(0);
        });
    }
  }
});
let inflight = 0;
let ended = false;
process.stdin.on('end', () => {
  ended = true;
  if (inflight === 0) process.exit(0);
});
