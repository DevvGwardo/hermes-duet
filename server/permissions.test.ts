import { expect, test } from 'bun:test';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDownDataDir } from './permissions';

test('the data directory and SQLite files are private to the user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-permissions-'));
  for (const name of ['duet.db', 'duet.db-wal', 'duet.db-shm']) writeFileSync(join(dir, name), name);
  lockDownDataDir(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const name of ['duet.db', 'duet.db-wal', 'duet.db-shm']) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
});

test('permission hardening tolerates a new data directory without SQLite sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-permissions-'));
  expect(() => lockDownDataDir(dir)).not.toThrow();
});
