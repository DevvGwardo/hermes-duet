import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The CLI is bash, so this test spawns the real script. DUET_LOG_DIR keeps it away from the install's log directory.
const CLI = resolve(import.meta.dir, '..', 'bin', 'hermes-duet');

function toPosixPath(p: string): string {
  const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
  return m ? `/${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}` : p.replaceAll('\\', '/');
}

function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';

  const candidates: string[] = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'usr', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    'C:\\msys64\\usr\\bin\\bash.exe',
  ];

  const gitPath = Bun.which('git');
  if (gitPath) {
    const gitRoot = resolve(dirname(gitPath), '..');
    candidates.push(join(gitRoot, 'bin', 'bash.exe'), join(gitRoot, 'usr', 'bin', 'bash.exe'));
  }

  // Skip the Windows System32/SysWOW64/WindowsApps WSL bash shims, which fail on Windows paths.
  const whereRes = Bun.spawnSync(['where.exe', 'bash'], { stdout: 'pipe', stderr: 'pipe' });
  if (whereRes.exitCode === 0) {
    for (const line of whereRes.stdout.toString().split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      if (/[\\/](?:system32|syswow64|windowsapps)[\\/]bash\.exe$/i.test(p)) continue;
      candidates.push(p);
    }
  }

  return candidates.find((p) => p && existsSync(p)) ?? null;
}

const BASH = findBash();
const runTest = BASH ? test : test.skip;

function rotate(dir: string, keep = '5') {
  if (!BASH) throw new Error('no non-WSL bash found');
  const isWin = process.platform === 'win32';
  const cliArg = isWin ? toPosixPath(CLI) : CLI;
  const logDir = isWin ? toPosixPath(dir) : dir;
  return Bun.spawnSync([BASH, cliArg, 'rotate-logs', keep], {
    env: { ...process.env, DUET_LOG_DIR: logDir, HOME: logDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function tempLog() {
  const dir = mkdtempSync(join(tmpdir(), 'duet-log-'));
  const log = join(dir, 'server.log');
  return { dir, log };
}

runTest('rotate-logs copies the live file, truncates it in place, and shifts generations', () => {
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

runTest('rotate-logs refuses a keep count that is not a positive integer', () => {
  const { dir } = tempLog();
  for (const keep of ['0', '-1', 'two']) {
    const res = rotate(dir, keep);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString()).toContain('usage');
  }
});

runTest('rotate-logs is a no-op when there is no log yet', () => {
  const { dir } = tempLog();
  const res = rotate(dir);
  expect(res.exitCode).toBe(0);
  expect(res.stdout.toString()).toContain('No server log');
});
