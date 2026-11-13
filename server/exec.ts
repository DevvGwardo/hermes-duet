// Shared subprocess helpers for local CLI probes and bounded command execution.
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

type Env = Record<string, string | undefined>;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isExecutableFile(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    if (process.platform !== 'win32') accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function whichCommand(cmd: string): string | null {
  if (!cmd) return null;
  if (isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    return isExecutableFile(cmd) ? cmd : null;
  }
  const pathEnv = process.env.PATH ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${cmd}${ext}`);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function hasCommand(cmd: string): boolean {
  return !!whichCommand(cmd);
}

export async function execCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: string; env?: Env } = {},
): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(opts.env ? { env: { ...process.env, ...(opts.env as Record<string, string>) } } : {}),
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout?.on('data', (chunk: Buffer) => outChunks.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => errChunks.push(chunk));

    if (opts.stdin !== undefined && proc.stdin) {
      proc.stdin.end(opts.stdin);
    }

    let settled = false;
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, opts.timeoutMs ?? 15_000);

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        out: Buffer.concat(outChunks).toString('utf8'),
        err: Buffer.concat(errChunks).toString('utf8'),
        code: code ?? 1,
      });
    });
  });
}
