// Files the user hands over from the composer: a photo of a receipt, a screenshot, a PDF, a voice memo. Uploads are
// stored under data/uploads with a generated name and 0600, and stay on this machine.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { type Attachment, attachmentKind } from '../shared/types';
import { config } from './config';
import { attachments, newId, toAttachment } from './db';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
};

/** Browsers send `audio/webm;codecs=opus`; the parameters are not part of the type we store. */
export function normalizeMime(raw: unknown): string {
  return String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

export function uploadExt(mime: string): string {
  return UPLOAD_TYPES[normalizeMime(mime)] ?? '';
}

export function checkUpload(mime: unknown, size: number) {
  const type = normalizeMime(mime);
  if (!UPLOAD_TYPES[type]) throw new Error(`can't take ${type || 'that kind of file'}; send an image, a PDF, text or audio`);
  if (!Number.isFinite(size) || size <= 0) throw new Error('that file is empty');
  if (size > MAX_UPLOAD_BYTES) throw new Error(`files are limited to ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
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

/** The extension a stored upload has; used only to keep a name the user recognizes. */
export const uploadExtOf = (name: string) => extname(name).toLowerCase();