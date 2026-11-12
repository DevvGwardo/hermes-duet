import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { attachments, db } from './db';
import {
  MAX_UPLOAD_BYTES,
  ORPHAN_UPLOAD_TTL_MS,
  UPLOAD_TYPES,
  checkBodySize,
  checkUpload,
  deleteUnlinkedUpload,
  displayName,
  isAudioMime,
  normalizeMime,
  prune,
  pruneOrphanUploads,
  saveUpload,
  uploadExt,
} from './uploads';

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
    const p = attachments.get(att.id)!.path;
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    } else {
      expect(Array.from(readFileSync(p))).toEqual([9]);
    }
  });

  test('refuses what checkUpload refuses', () => {
    expect(() => saveUpload({ bytes: new Uint8Array([1]), mime: 'text/html' })).toThrow();
    expect(() => saveUpload({ bytes: new Uint8Array(0), mime: 'image/png' })).toThrow();
  });
});
describe("checkBodySize", () => {
  test("passes normal and exact-limit sizes", () => {
    expect(() => checkBodySize(1024)).not.toThrow();
    expect(() => checkBodySize(MAX_UPLOAD_BYTES)).not.toThrow();
  });

  test("refuses oversized and non-finite buffers", () => {
    expect(() => checkBodySize(MAX_UPLOAD_BYTES + 1)).toThrow(/25 MB/);
    expect(() => checkBodySize(Number.NaN)).toThrow(/25 MB/);
  });
});

describe('expanded audio formats, deleteUnlinkedUpload & orphan pruning', () => {
  test('accepts all expanded audio MIME types and video/mp4, stripping parameters', () => {
    const cases: [string, string][] = [
      ['audio/webm;codecs=opus', '.webm'],
      ['audio/mp4;codecs=mp4a.40.2', '.m4a'],
      ['audio/x-m4a', '.m4a'],
      ['audio/m4a', '.m4a'],
      ['audio/mpeg', '.mp3'],
      ['audio/mp3', '.mp3'],
      ['audio/wav', '.wav'],
      ['audio/x-wav', '.wav'],
      ['audio/wave', '.wav'],
      ['audio/ogg; codecs=opus', '.ogg'],
      ['audio/aac', '.aac'],
      ['audio/flac', '.flac'],
      ['audio/3gpp', '.3gp'],
      ['video/mp4', '.mp4'],
    ];
    for (const [mime, expectedExt] of cases) {
      expect(uploadExt(mime)).toBe(expectedExt);
      expect(() => checkUpload(mime, 128)).not.toThrow();
      expect(isAudioMime(mime)).toBe(true);
    }
    expect(isAudioMime('image/png')).toBe(false);
    expect(isAudioMime('application/pdf')).toBe(false);
  });

  test('deleteUnlinkedUpload deletes unlinked files from DB and disk, refuses linked (409) and missing (404)', () => {
    const unlinked = saveUpload({ bytes: new Uint8Array([1, 2, 3]), mime: 'audio/ogg', filename: 'draft.ogg' });
    const unlinkedPath = attachments.get(unlinked.id)!.path;
    expect(existsSync(unlinkedPath)).toBe(true);
    deleteUnlinkedUpload(unlinked.id);
    expect(attachments.get(unlinked.id)).toBeNull();
    expect(existsSync(unlinkedPath)).toBe(false);

    expect(() => deleteUnlinkedUpload('no-such-upload-id')).toThrow(/not found/);

    const linked = saveUpload({ bytes: new Uint8Array([4, 5, 6]), mime: 'audio/flac', filename: 'keep.flac' });
    const linkedPath = attachments.get(linked.id)!.path;
    attachments.link([linked.id], 'item-linked-test');
    expect(() => deleteUnlinkedUpload(linked.id)).toThrow(/already attached/);
    expect(attachments.get(linked.id)).not.toBeNull();
    expect(existsSync(linkedPath)).toBe(true);
  });

  test('pruneOrphanUploads and prune delete unlinked uploads older than 24h while keeping recent or linked ones', () => {
    const now = Date.now();
    const staleUnlinked = saveUpload({ bytes: new Uint8Array([1, 2]), mime: 'audio/mp3', filename: 'stale.mp3' });
    const freshUnlinked = saveUpload({ bytes: new Uint8Array([3, 4]), mime: 'audio/m4a', filename: 'fresh.m4a' });
    const staleLinked = saveUpload({ bytes: new Uint8Array([5, 6]), mime: 'audio/3gpp', filename: 'linked.3gp' });
    attachments.link([staleLinked.id], 'item-keep-old');

    const oldTs = now - ORPHAN_UPLOAD_TTL_MS - 60_000;
    db.query('UPDATE attachments SET created_at = ? WHERE id IN (?, ?)').run(oldTs, staleUnlinked.id, staleLinked.id);
    db.query('UPDATE attachments SET created_at = ? WHERE id = ?').run(now - 60_000, freshUnlinked.id);

    const stalePath = attachments.get(staleUnlinked.id)!.path;
    const freshPath = attachments.get(freshUnlinked.id)!.path;
    const linkedPath = attachments.get(staleLinked.id)!.path;

    const removed = pruneOrphanUploads(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(attachments.get(staleUnlinked.id)).toBeNull();
    expect(existsSync(stalePath)).toBe(false);

    expect(attachments.get(freshUnlinked.id)).not.toBeNull();
    expect(existsSync(freshPath)).toBe(true);
    expect(attachments.get(staleLinked.id)).not.toBeNull();
    expect(existsSync(linkedPath)).toBe(true);

    // Calling unified prune() at now + 25h cleans up the remaining unlinked upload too.
    const later = prune(now + ORPHAN_UPLOAD_TTL_MS + 120_000);
    expect(later.orphanUploads).toBeGreaterThanOrEqual(1);
    expect(attachments.get(freshUnlinked.id)).toBeNull();
    expect(existsSync(freshPath)).toBe(false);
    expect(existsSync(linkedPath)).toBe(true);
  });
});
