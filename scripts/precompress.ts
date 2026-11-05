#!/usr/bin/env bun
// Precompress the built PWA so the server can serve `.br`/`.gz` siblings without doing it per request.
// Run automatically by `bun run build`; `server/index.ts` picks the sibling that matches Accept-Encoding.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dir, '..', 'web', 'dist');
const TYPES = new Set(['.js', '.css', '.html', '.json', '.webmanifest', '.svg', '.txt', '.xml']);

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

if (!existsSync(ROOT)) {
  console.log('[precompress] web/dist is missing; run the Vite build first');
  process.exit(0);
}

let files = 0;
for (const path of walk(ROOT)) {
  if (!TYPES.has(extname(path).toLowerCase())) continue;
  const source = statSync(path);
  const bytes = readFileSync(path);
  for (const [suffix, encode] of [
    ['.br', () => brotliCompressSync(bytes)],
    ['.gz', () => gzipSync(bytes, { level: 9 })],
  ] as const) {
    const out = `${path}${suffix}`;
    try {
      // A rebuild rewrites the source; reuse the sibling when it is already newer.
      if (statSync(out).mtimeMs >= source.mtimeMs) continue;
    } catch {}
    writeFileSync(out, encode());
    files++;
  }
}
console.log(`[precompress] ${files} file${files === 1 ? '' : 's'} written under web/dist`);
