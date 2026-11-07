#!/usr/bin/env bun
// Production receipt for the streaming multipart route (GAPS 2.3): pair a throwaway device
// through the internal API (same path scripts/smoke.ts uses), POST a small multipart upload
// to the live server, and read it back bit-for-bit. Exercises server/multipart.ts end to end
// on the running launchd service, not just in tests.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const APP = `http://127.0.0.1:${process.env.DUET_PORT ?? 7456}`;
const INTERNAL = `http://127.0.0.1:${process.env.DUET_INTERNAL_PORT ?? 7457}`;
const token = readFileSync(join(root, 'data', 'internal.token'), 'utf8').trim();

const { code } = (await (await fetch(`${INTERNAL}/internal/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as any;
const res = await fetch(`${APP}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'multipart-prod-smoke' }, body: JSON.stringify({ code }) });
const cookie = res.headers.get('set-cookie')?.split(';')[0];
if (!res.ok || !cookie) throw new Error(`pair failed ${res.status}`);

// 1x1 transparent PNG, uploaded through a REAL multipart form as any phone would send it.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89]);
const form = new FormData();
form.append('file', new File([png], 'smoke.png', { type: 'image/png' }));
const up = await fetch(`${APP}/api/uploads`, { method: 'POST', headers: { cookie }, body: form });
if (!up.ok) throw new Error(`upload failed ${up.status} ${await up.text()}`);
const { attachment } = (await up.json()) as any;
console.log('upload:', attachment.id, attachment.mime, attachment.size, 'bytes');

const back = await fetch(`${APP}/api/uploads/${attachment.id}`, { headers: { cookie } });
if (!back.ok) throw new Error(`download failed ${back.status}`);
const bytes = new Uint8Array(await back.arrayBuffer());
if (bytes.length !== png.length || bytes.some((b, i) => b !== png[i])) throw new Error('bytes mismatch');
console.log('readback: bit-identical, streaming upload route VERIFIED in production');
