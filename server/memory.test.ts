import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config';
import { MEMORY_MAX_BYTES, clearMemory, readMemory, writeMemory } from './memory';

const ORIGINAL_CONTEXT = config.contextFile;
afterEach(() => {
  config.contextFile = ORIGINAL_CONTEXT;
});

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'duet-memory-')), 'context.local.md');
}

describe('memory', () => {
  test('reads an empty state when the file is missing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'duet-memory-')), 'missing.md');
    config.contextFile = path;
    expect(readMemory()).toEqual({ path, text: '', max_bytes: MEMORY_MAX_BYTES });
  });

  test('writes plain UTF-8, creating the directory, and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-memory-'));
    const path = join(dir, 'nested', 'context.local.md');
    config.contextFile = path;
    const state = writeMemory('- Notes: café ☕');
    expect(state.text).toBe('- Notes: café ☕');
    expect(readFileSync(path, 'utf8')).toBe('- Notes: café ☕');
    expect(readMemory().text).toBe('- Notes: café ☕');
  });

  test('caps the text at 32 KB, measured in bytes', () => {
    config.contextFile = tempFile();
    expect(() => writeMemory('x'.repeat(MEMORY_MAX_BYTES + 1))).toThrow();
    // Exactly at the cap is fine; multibyte characters count as their UTF-8 bytes.
    writeMemory('x'.repeat(MEMORY_MAX_BYTES));
    expect(readMemory().text).toHaveLength(MEMORY_MAX_BYTES);
    expect(() => writeMemory('€'.repeat(MEMORY_MAX_BYTES))).toThrow();
  });

  test('clear removes the file so the next read is empty', () => {
    const path = tempFile();
    config.contextFile = path;
    writeMemory('remember this');
    expect(existsSync(path)).toBe(true);
    expect(clearMemory()).toEqual({ path, text: '', max_bytes: MEMORY_MAX_BYTES });
    expect(existsSync(path)).toBe(false);
    expect(readMemory().text).toBe('');
  });

  test('rethrows real read errors instead of treating them as an empty memory file', () => {
    config.contextFile = tempFile();
    expect(() =>
      readMemory(() => {
        const err: NodeJS.ErrnoException = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      }),
    ).toThrow('permission denied');
    expect(() =>
      readMemory(() => {
        const err: NodeJS.ErrnoException = new Error('i/o failure');
        err.code = 'EIO';
        throw err;
      }),
    ).toThrow('i/o failure');
  });
});
