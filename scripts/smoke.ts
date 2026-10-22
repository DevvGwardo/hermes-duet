#!/usr/bin/env bun
// Live end-to-end check against the running Hermes Duet server and real Hermes.
//   bun scripts/smoke.ts            approval flow (asks to create a file, approves, checks it exists)
//   bun scripts/smoke.ts task       background task flow (start_task -> deliver_file -> done)
// It pairs a throwaway device through the internal API, so the server must be running.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Item, Snapshot } from '../shared/types';

const root = resolve(import.meta.dir, '..');
const APP = `http://127.0.0.1:${process.env.DUET_PORT ?? 7456}`;
const INTERNAL = `http://127.0.0.1:${process.env.DUET_INTERNAL_PORT ?? 7457}`;
const token = readFileSync(join(root, 'data', 'internal.token'), 'utf8').trim();

async function pair(): Promise<string> {
  const { code } = (await (await fetch(`${INTERNAL}/internal/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as any;
  const res = await fetch(`${APP}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'duet-smoke' }, body: JSON.stringify({ code }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!res.ok || !cookie) throw new Error(`pair failed ${res.status}`);
  return cookie;
}

const cookie = await pair();
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${APP}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
};
const state = () => api('GET', '/api/state') as Promise<Snapshot>;

async function waitFor<T>(what: string, fn: (s: Snapshot) => T | undefined | null | false, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn(await state());
    if (v) return v;
    await Bun.sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const after = Date.now();
const fresh = (s: Snapshot) => s.items.filter((i) => i.created_at >= after);
const show = (i: Item) => `${i.kind}${i.card ? `/${i.card.type}:${i.card.status}` : ''} ${(i.text ?? i.card?.title ?? i.activity?.status ?? '').slice(0, 120).replace(/\n/g, ' ')}`;

const mode = process.argv[2] ?? 'approval';

if (mode === 'approval') {
  const target = join(homedir(), 'duet-work', 'smoke', 'approved.txt');
  rmSync(target, { force: true });
  await api('POST', '/api/messages', {
    text: `Smoke test: I want a file at ${target} containing the word "approved". Treat creating it as a sensitive action: ask my approval first with request_approval, and only create it after I approve.`,
  });
  const card = await waitFor('approval card', (s) => fresh(s).find((i) => i.card?.type === 'approval' && i.card.status === 'pending'));
  console.log('✓ approval card:', card.card!.title);
  await waitFor('agent idle', (s) => !s.agent.busy);
  if (existsSync(target)) throw new Error('✗ file was created BEFORE approval');
  console.log('✓ nothing done before approval');
  await api('POST', `/api/cards/${card.id}/act`, { action: 'approve' });
  await waitFor('file after approval', () => existsSync(target), 180_000);
  console.log('✓ file created after approval:', readFileSync(target, 'utf8').trim());
  await waitFor('agent idle', (s) => !s.agent.busy);
} else if (mode === 'task') {
  await api('POST', '/api/messages', {
    text: 'Smoke test: start a background task (start_task) that writes a tiny self-contained HTML dashboard with three made-up metrics to ~/duet-work/smoke/dashboard.html and delivers it with deliver_file. Keep it quick.',
  });
  const task = await waitFor('task created', (s) => s.tasks.find((t) => t.created_at >= after));
  console.log('✓ task started:', task.title);
  const done = await waitFor('task finished', (s) => s.tasks.find((t) => t.id === task.id && ['done', 'failed', 'waiting'].includes(t.status)), 420_000);
  console.log(`${done.status === 'done' ? '✓' : '✗'} task ${done.status}:`, done.result);
  const s = await state();
  const file = s.files.find((f) => f.created_at >= after);
  console.log(file ? `✓ file delivered: ${file.title} (${file.mime}, ${file.size} B)` : '✗ no file delivered');
}

if (mode === 'steer') {
  // A message sent mid-run should reach the same turn (or the next one), never get lost.
  await api('POST', '/api/messages', { text: 'Smoke test: run `sleep 25` in the terminal, then reply "slept".' });
  await waitFor('run busy', (s) => s.agent.busy, 30_000);
  await Bun.sleep(6000);
  await api('POST', '/api/messages', { text: 'Also include the word "pineapple" in your reply.' });
  await waitFor('idle', (s) => !s.agent.busy && s.agent.queued === 0, 240_000);
  await Bun.sleep(3000);
  const s = await waitFor('idle again', (s) => (!s.agent.busy && s.agent.queued === 0 ? s : null), 240_000);
  const said = fresh(s).filter((i) => i.kind === 'assistant').map((i) => i.text ?? '').join('\n');
  console.log(/pineapple/i.test(said) ? '✓ steer reached the agent' : '✗ steer text not reflected');
}

if (mode === 'stop') {
  await api('POST', '/api/messages', { text: 'Smoke test: run `sleep 120` in the terminal, then reply "done".' });
  await waitFor('run busy', (s) => s.agent.busy, 30_000);
  await Bun.sleep(8000);
  await api('POST', '/api/runs/stop');
  const s = await waitFor('stopped', (s) => (!s.agent.busy ? s : null), 60_000);
  const act = fresh(s).find((i) => i.kind === 'activity');
  console.log(act?.activity?.status === 'stopped' ? '✓ run stopped' : `✗ activity status ${act?.activity?.status}`);
}

console.log('\nthread since start:');
for (const i of fresh(await state())) console.log('  ', show(i));
