#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// Historical durations (ms) so greedy LPT sharding keeps slow integration tests
// balanced against smaller unit test files without requiring Bun >=1.4 --shard.
const KNOWN_WEIGHTS_MS = {
  'server/runner.test.ts': 5500,
  'server/db.test.ts': 960,
  'scripts/log-rotation.test.ts': 930,
  'server/index.test.ts': 440,
  'server/triggers-runtime.test.ts': 260,
  'server/triggers.test.ts': 260,
  'server/mcp-shim.test.ts': 200,
  'server/routines.test.ts': 180,
  'server/scheduler.test.ts': 140,
  'server/push.test.ts': 130,
  'server/uploads.test.ts': 120,
};

export function discoverTests(rootDir) {
  const results = [];
  function walk(dir, relPrefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const rel = relPrefix ? posix.join(relPrefix, entry.name) : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        results.push(rel);
      }
    }
  }
  walk(rootDir, rootDir.replace(/\\/g, '/').replace(/\/+$/, ''));
  return results.sort();
}

export function partitionShards(files, totalShards) {
  const shards = Array.from({ length: totalShards }, () => ({ load: 0, files: [] }));
  const weighted = files
    .map((file) => ({ file, weight: KNOWN_WEIGHTS_MS[file] ?? 25 }))
    .sort((a, b) => b.weight - a.weight || a.file.localeCompare(b.file));

  for (const item of weighted) {
    let lightest = shards[0];
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].load < lightest.load) lightest = shards[i];
    }
    lightest.files.push(item.file);
    lightest.load += item.weight;
  }

  for (const shard of shards) shard.files.sort();
  return shards;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => a !== '--dry-run');
  const [dir = 'server', shardArg = '1', totalArg = '2'] = positional;
  const shardIndex = Number.parseInt(shardArg, 10);
  const totalShards = Number.parseInt(totalArg, 10);

  if (!Number.isInteger(shardIndex) || !Number.isInteger(totalShards) || shardIndex < 1 || shardIndex > totalShards) {
    console.error(`Invalid shard specification: ${shardArg}/${totalArg}`);
    process.exit(2);
  }

  const allFiles = discoverTests(dir);
  const shards = partitionShards(allFiles, totalShards);
  const selected = shards[shardIndex - 1];

  console.log(
    `[shard ${shardIndex}/${totalShards}] ${selected.files.length}/${allFiles.length} test files (est. ${selected.load}ms)`,
  );
  if (selected.files.length === 0) process.exit(0);
  if (dryRun) {
    console.log(selected.files.join('\n'));
    process.exit(0);
  }

  const bunBin = process.versions.bun ? process.execPath : 'bun';
  const res = spawnSync(bunBin, ['test', ...selected.files], {
    stdio: 'inherit',
    shell: !process.versions.bun && process.platform === 'win32',
  });
  if (res.error) {
    console.error(res.error);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
