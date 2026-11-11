import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverySource } from './delivery';

function trySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link);
    return true;
  } catch (e: any) {
    // Creating file symlinks on unprivileged Windows hosts raises EPERM unless Developer Mode is enabled.
    if (process.platform === 'win32' && e?.code === 'EPERM') return false;
    throw e;
  }
}

describe('deliver_file source validation', () => {
  test('a symlink cannot smuggle a denied secret past the path check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-delivery-'));
    try {
      const ssh = join(dir, '.ssh');
      mkdirSync(ssh);
      const secret = join(ssh, 'id_rsa');
      writeFileSync(secret, 'not-a-real-key');
      expect(() => deliverySource(secret)).toThrow('looks like secrets');
      const link = join(dir, 'report.html');
      if (!trySymlink(secret, link)) return;
      expect(() => deliverySource(link)).toThrow('looks like secrets');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ordinary file and a safe symlink still resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-delivery-'));
    try {
      const file = join(dir, 'report.html');
      writeFileSync(file, '<h1>ok</h1>');
      expect(deliverySource(file)).toBe(realpathSync(file));
      const link = join(dir, 'latest.html');
      if (trySymlink(file, link)) expect(deliverySource(link)).toBe(realpathSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('relative paths and direct secret paths are refused (including Windows separators)', () => {
    expect(() => deliverySource('report.html')).toThrow('must be absolute');
    expect(() => deliverySource(join(tmpdir(), '.env'))).toThrow('looks like secrets');
    expect(() => deliverySource(join(tmpdir(), '.env.production'))).toThrow('looks like secrets');
    expect(() => deliverySource(join(tmpdir(), '.ssh', 'config'))).toThrow('looks like secrets');
    expect(() => deliverySource(join(tmpdir(), '.aws', 'config'))).toThrow('looks like secrets');
    expect(() => deliverySource(join(tmpdir(), '.config', 'gcloud', 'application_default_credentials.json'))).toThrow('looks like secrets');
    expect(() => deliverySource(join(tmpdir(), 'Keychains', 'login.keychain-db'))).toThrow('looks like secrets');
    if (process.platform === 'win32') {
      expect(() => deliverySource('C:\\Users\\alice\\.env')).toThrow('looks like secrets');
      expect(() => deliverySource('C:\\Users\\alice\\.config\\gcloud\\credentials.db')).toThrow('looks like secrets');
    }
  });
});
