// Files the user hands over from the composer: a photo of a receipt, a screenshot, a PDF, a voice memo. Uploads are
// stored under data/uploads with a generated name and 0600, and stay on this machine.
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { type Attachment, attachmentKind } from '../shared/types';
import { config } from './config';
import { attachments, db, newId, prune as dbPrune, toAttachment, tx } from './db';
import { UserError } from './errors';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const ORPHAN_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What we accept, and the extension it is stored as. The extension is chosen from this table and never from the
 * client's filename: a name like `../../launch.sh` or `x.html` cannot decide where the file lands or how it is served.
 */
export const UPLOAD_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/3gpp': '.3gp',
  'video/mp4': '.mp4',
};

/** Browsers send `audio/webm;codecs=opus`; the parameters are not part of the type we store. */
export function normalizeMime(raw: unknown): string {
  return String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

export function isAudioMime(raw: unknown): boolean {
  const mime = normalizeMime(raw);
  return mime.startsWith('audio/') || mime === 'video/mp4';
}

export function uploadExt(mime: string): string {
  return UPLOAD_TYPES[normalizeMime(mime)] ?? '';
}

export function checkUpload(mime: unknown, size: number) {
  const type = normalizeMime(mime);
  // The echoed type is the client's own text; keep it short so a long header cannot bloat the response.
  if (!UPLOAD_TYPES[type]) throw new UserError(`can't take ${type.slice(0, 40) || 'that kind of file'}; send an image, a PDF, text or audio`);
  if (!Number.isFinite(size) || size <= 0) throw new UserError('that file is empty');
  if (size > MAX_UPLOAD_BYTES) throw new UserError(`files are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`, 413);
}

/** A display name only: no directories, no control characters, short enough for a card. */
export function displayName(raw: unknown, mime: string): string {
  const name = basename(String(raw ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 80);
  if (name && !name.startsWith('.')) return name;
  return `${attachmentKind(normalizeMime(mime)) === 'audio' ? 'Voice memo' : 'Upload'}${uploadExt(mime) || '.bin'}`;
}

export const uploadDir = () => join(config.dataDir, 'uploads');

/**
 * Store one upload and register it. `id` is generated here, so two files with the same name never collide and the
 * stored path never contains anything from the request.
 */
export function saveUpload(input: { bytes: Uint8Array; mime: string; filename?: string }): Attachment {
  const mime = normalizeMime(input.mime);
  checkUpload(mime, input.bytes.byteLength);
  const id = newId();
  const dir = uploadDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}${uploadExt(mime)}`);
  writeFileSync(path, input.bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return toAttachment(attachments.add({ id, filename: displayName(input.filename, mime), mime, size: input.bytes.byteLength, path }));
}

/** Hard byte ceiling for a buffered request body the server reads whole. */
export function checkBodySize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes > MAX_UPLOAD_BYTES) throw new UserError(`files are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`, 413);
}

/** The extension a stored upload has; used only to keep a name the user recognizes. */
export const uploadExtOf = (name: string) => extname(name).toLowerCase();

/**
 * Remove an unlinked upload (`item_id IS NULL`) from SQLite and disk. Linked attachments belong to thread history
 * and return 409 so a client cannot delete a file already referenced by a message or task.
 */
export function deleteUnlinkedUpload(id: string): void {
  const row = attachments.get(id);
  if (!row) throw new UserError('upload not found', 404);
  if (row.item_id !== null) throw new UserError('upload is already attached', 409);
  const deleted = tx(() => db.query('DELETE FROM attachments WHERE id = ? AND item_id IS NULL').run(id).changes);
  if (deleted === 0) {
    const current = attachments.get(id);
    if (current && current.item_id !== null) throw new UserError('upload is already attached', 409);
    throw new UserError('upload not found', 404);
  }
  rmSync(row.path, { force: true });
}

/** Delete unlinked (`item_id IS NULL`) orphan uploads older than `maxAgeMs` (24 hours by default) from DB and disk. */
export function pruneOrphanUploads(now = Date.now(), maxAgeMs = ORPHAN_UPLOAD_TTL_MS): number {
  const cutoff = now - maxAgeMs;
  const stale = db
    .query<{ id: string; path: string }, [number]>('SELECT id, path FROM attachments WHERE item_id IS NULL AND created_at < ?')
    .all(cutoff);
  let removed = 0;
  for (const row of stale) {
    const changes = db.query('DELETE FROM attachments WHERE id = ? AND item_id IS NULL').run(row.id).changes;
    if (changes > 0) {
      rmSync(row.path, { force: true });
      removed++;
    }
  }
  const incoming = join(uploadDir(), 'incoming');
  if (existsSync(incoming)) {
    try {
      for (const name of readdirSync(incoming)) {
        const p = join(incoming, name);
        try {
          const st = statSync(p);
          if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true });
        } catch {}
      }
    } catch {}
  }
  return removed;
}

/** Run DB housekeeping plus orphan-upload cleanup. */
export function prune(now = Date.now(), maxAgeMs = ORPHAN_UPLOAD_TTL_MS): { runs: number; codes: number; orphanUploads: number } {
  const dbResult = dbPrune(now);
  const orphanUploads = pruneOrphanUploads(now, maxAgeMs);
  return { ...dbResult, orphanUploads };
}