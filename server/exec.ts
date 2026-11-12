// Shared subprocess helpers for local CLI probes and bounded command execution.
type Env = Record<string, string | undefined>;

export function whichCommand(cmd: string): string | null {
  try {
    return Bun.which(cmd);
  } catch {
    return null;
  }
}

export function hasCommand(cmd: string): boolean {
  return !!whichCommand(cmd);
}

export async function execCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; stdin?: string; env?: Env } = {},
): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.env ? { env: { ...process.env, ...(opts.env as Record<string, string>) } } : {}),
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 15_000);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } finally {
    clearTimeout(timer);
  }
}
