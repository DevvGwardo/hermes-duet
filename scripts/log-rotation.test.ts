import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The CLI is bash, so this test spawns the real script. DUET_LOG_DIR keeps it away from the install's log directory.
const CLI = resolve(import.meta.dir, '..', 'bin', 'hermes-duet');

function rotate(dir: string, keep = '5') {
  return Bun.spawnSync(['bash', CLI, 'rotate-logs', keep], {
    env: { ...process.env, DUET_LOG_DIR: dir, HOME: dir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), 'duet-log-'));
  const log = join(dir, 'server.log');
  return { dir, log };
}

test('rotate-logs copies the live file, truncates it in place, and shifts generations', () => {
  const { dir, log } = tempLog();
  writeFileSync(log, 'first\n');
  expect(rotate(dir, '2').exitCode).toBe(0);
  expect(readFileSync(log, 'utf8')).toBe('');
  expect(readFileSync(`${log}.1`, 'utf8')).toBe('first\n');

  writeFileSync(log, 'second\n');
  expect(rotate(dir, '2').exitCode).toBe(0);
  expect(readFileSync(`${log}.1`, 'utf8')).toBe('second\n');
  expect(readFileSync(`${log}.2`, 'utf8')).toBe('first\n');
  // The oldest generation is dropped, not grown without bound.
  expect(existsSync(`${log}.3`)).toBe(false);
});

test('rotate-logs refuses a keep count that is not a positive integer', () => {
  const { dir } = tempLog();
  for (const keep of ['0', '-1', 'two']) {
    const res = rotate(dir, keep);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString()).toContain('usage');
  }
});

test('rotate-logs is a no-op when there is no log yet', () => {
  const { dir } = tempLog();
  const res = rotate(dir);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain('No server log');
});
