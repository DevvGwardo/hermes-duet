// The context file is the agent's memory: the one file it starts every turn with. The API only ever touches
// config.contextFile, so there is no path a caller can point at another file.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MemoryState } from '../shared/types';
import { config } from './config';
import { UserError } from './errors';

/** The one hard cap on the memory file, in UTF-8 bytes. */
export const MEMORY_MAX_BYTES = 32 * 1024;

function state(text: string): MemoryState {
  return { path: config.contextFile, text, max_bytes: MEMORY_MAX_BYTES };
}

/** Refuse a configured path that cannot be a file, before anything is written through it. */
function checkTarget(path: string) {
  if (!path || path.includes('\0')) throw new UserError('no context file is configured', 400);
  if (existsSync(path) && statSync(path).isDirectory()) throw new UserError('the context file is a directory', 400);
}

export function readMemory(read: (path: string, encoding: 'utf8') => string = readFileSync): MemoryState {
  checkTarget(config.contextFile);
  let text = '';
  try {
    text = read(config.contextFile, 'utf8');
  } catch (e: any) {
    // A missing file is an empty memory, not an error: the agent starts with the default context.
    if (e?.code !== 'ENOENT') throw e;
  }
  return state(text);
}

/**
 * Write through a sibling temp file and rename it into place, so a crash or a killed request leaves the previous
 * memory whole rather than a half-written file the next turn would read.
 */
function writeAtomic(text: string) {
  const target = config.contextFile;
  checkTarget(target);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${target.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function writeMemory(text: string): MemoryState {
  if (typeof text !== 'string') throw new UserError('memory must be text', 400);
  if (Buffer.byteLength(text, 'utf8') > MEMORY_MAX_BYTES) throw new UserError('memory is too large', 413);
  writeAtomic(text);
  return state(text);
}

/** Remove the file so the next turn starts with none of it. A missing file is already clear. */
export function clearMemory(): MemoryState {
  checkTarget(config.contextFile);
  rmSync(config.contextFile, { force: true });
  return state('');
}
