import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockDownDataDir } from './permissions';

test('the data directory and SQLite files are private to the user', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-permissions-'));
  try {
    for (const name of ['duet.db', 'duet.db-wal', 'duet.db-shm']) writeFileSync(join(dir, name), name);
    expect(() => lockDownDataDir(dir)).not.toThrow();
    // NTFS does not enforce POSIX permission mode bits, so st_mode assertions apply only on POSIX platforms.
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of ['duet.db', 'duet.db-wal', 'duet.db-shm']) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('permission hardening tolerates a new data directory without SQLite sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duet-permissions-'));
  try {
    expect(() => lockDownDataDir(dir)).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
