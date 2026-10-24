import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverySource } from './delivery';

describe('deliver_file source validation', () => {
  test('a symlink cannot smuggle a denied secret past the path check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-delivery-'));
    const ssh = join(dir, '.ssh');
    mkdirSync(ssh);
    const secret = join(ssh, 'id_rsa');
    writeFileSync(secret, 'not-a-real-key');
    const link = join(dir, 'report.html');
    symlinkSync(secret, link);
    expect(() => deliverySource(link)).toThrow('looks like secrets');
  });

  test('an ordinary file and a safe symlink still resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duet-delivery-'));
    const file = join(dir, 'report.html');
    writeFileSync(file, '<h1>ok</h1>');
    expect(deliverySource(file)).toBe(realpathSync(file));
    const link = join(dir, 'latest.html');
    symlinkSync(file, link);
    expect(deliverySource(link)).toBe(realpathSync(file));
  });

  test('relative paths and direct secret paths are refused', () => {
    expect(() => deliverySource('report.html')).toThrow('must be absolute');
    expect(() => deliverySource('/tmp/.env')).toThrow('looks like secrets');
  });
});
