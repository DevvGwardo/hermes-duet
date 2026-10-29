import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { attachments } from './db';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, checkUpload, displayName, normalizeMime, saveUpload, uploadExt } from './uploads';

describe('normalizeMime', () => {
  test('drops codec parameters and case', () => {
    expect(normalizeMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeMime('IMAGE/JPEG')).toBe('image/jpeg');
    expect(normalizeMime(' image/png ; charset=x ')).toBe('image/png');
  });

  test('junk becomes empty', () => {
    expect(normalizeMime(undefined)).toBe('');
    expect(normalizeMime(null)).toBe('');
  });
});

describe('uploadExt', () => {
  test('stores each accepted type with its own extension', () => {
    expect(uploadExt('image/jpeg')).toBe('.jpg');
    expect(uploadExt('image/png')).toBe('.png');
    expect(uploadExt('application/pdf')).toBe('.pdf');
    expect(uploadExt('audio/mp4')).toBe('.m4a');
    expect(uploadExt('audio/webm;codecs=opus')).toBe('.webm');
  });

  test('refuses anything not on the list, including html', () => {
    expect(uploadExt('text/html')).toBe('');
    expect(uploadExt('application/x-sh')).toBe('');
    expect(uploadExt('')).toBe('');
  });
});

describe('checkUpload', () => {
  test('accepts a normal photo', () => {
    expect(() => checkUpload('image/jpeg', 120_000)).not.toThrow();
  });

  test('rejects a type we cannot store safely', () => {
    expect(() => checkUpload('text/html', 10)).toThrow(/can't take/);
    expect(() => checkUpload('image/svg+xml', 10)).not.toThrow();
    expect(Object.keys(UPLOAD_TYPES)).toContain('image/svg+xml');
  });

  test('rejects empty and oversized files', () => {
    expect(() => checkUpload('image/png', 0)).toThrow(/empty/);
    expect(() => checkUpload('image/png', Number.NaN)).toThrow(/empty/);
    expect(() => checkUpload('image/png', MAX_UPLOAD_BYTES + 1)).toThrow(/25 MB/);
  });
});

describe('displayName', () => {
  test('keeps a readable name and drops directories', () => {
    expect(displayName('receipt.png', 'image/png')).toBe('receipt.png');
    expect(displayName('../../etc/passwd', 'image/png')).toBe('passwd');
    expect(displayName('/Users/me/Desktop/statement.pdf', 'application/pdf')).toBe('statement.pdf');
  });

  test('strips control characters and caps the length', () => {
    expect(displayName('a\u0000b\u001fc.png', 'image/png')).toBe('abc.png');
    expect(displayName(`${'x'.repeat(200)}.png`, 'image/png').length).toBe(80);
  });

  test('falls back to a name the user recognizes', () => {
    expect(displayName('', 'audio/webm')).toBe('Voice memo.webm');
    expect(displayName('.hidden', 'image/png')).toBe('Upload.png');
    expect(displayName(undefined, 'application/pdf')).toBe('Upload.pdf');
  });
});

describe('saveUpload', () => {
  test('stores bytes under a server-generated path that round-trips', () => {
    const bytes = new TextEncoder().encode('hc-receipt-bytes');
    const att = saveUpload({ bytes, mime: 'image/png', filename: '../../evil.png' });
    const row = attachments.get(att.id)!;
    expect(row.path).not.toContain('evil');
    expect(row.path.endsWith('.png')).toBe(true);
    expect(readFileSync(row.path).toString()).toBe('hc-receipt-bytes');
    expect(att.size).toBe(bytes.byteLength);
  });

  test('the same filename twice never collides', () => {
    const a = saveUpload({ bytes: new Uint8Array([1]), mime: 'image/png', filename: 'scan.png' });
    const b = saveUpload({ bytes: new Uint8Array([2]), mime: 'image/png', filename: 'scan.png' });
    expect(a.id).not.toBe(b.id);
    expect(attachments.get(a.id)!.path).not.toBe(attachments.get(b.id)!.path);
  });

  test('stored uploads are owner-read-only', () => {
    const att = saveUpload({ bytes: new Uint8Array([9]), mime: 'application/pdf', filename: 's.pdf' });
    expect(statSync(attachments.get(att.id)!.path).mode & 0o777).toBe(0o600);
  });

  test('refuses what checkUpload refuses', () => {
    expect(() => saveUpload({ bytes: new Uint8Array([1]), mime: 'text/html' })).toThrow();
    expect(() => saveUpload({ bytes: new Uint8Array(0), mime: 'image/png' })).toThrow();
  });
});