// Streaming multipart/form-data reader with a hard byte cap (GAPS 2.3): the file part is staged
// to disk as it arrives and the request stream is CANCELLED the moment the cap is exceeded, so an
// oversized chunked body costs at most `cap` bytes of reading instead of being fully buffered
// before validation. Only the bytes after a possible boundary split are ever held back.
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './errors';

const te = new TextEncoder();
const dec = new TextDecoder();
const HEADER_CAP = 16 * 1024;
const FIELD_CAP = 8 * 1024;

export interface MultipartStaged {
  path: string;
  size: number;
  filename: string;
  mime: string;
}
export interface MultipartResult {
  fields: Record<string, string>;
  file: MultipartStaged | null;
}

/** Throw for anything a client did wrong that it can fix by resending. A declaration (not an arrow) so CFA treats it as unreachable after the call. */
function bad(msg: string): never {
  throw new UserError(msg, 400);
}

export function boundaryFrom(contentType: string | null | undefined): string {
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('multipart/form-data')) bad('send the upload as multipart form data');
  const m = contentType.match(/boundary=("([^"]+)"|([^;,\s]+))/i);
  const b = (m ? (m[2] ?? m[3]) : '') ?? '';
  if (!b || b.length > 78 || /[\r\n"]/g.test(b)) bad('send the upload as multipart form data');
  return b;
}

/** naive needle search — the needles here are <= 84 bytes and the stream is capped, so this is fine */
function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    if (hay[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** `name=`-style content-disposition attributes (with quoted or bare values). */
function headerAttr(headers: string, attr: string): string | null {
  const m = headers.match(new RegExp(`${attr}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\r\\n]+))`, 'i'));
  if (!m) return null;
  return (m[1] ?? m[2])?.trim() ?? null;
}

/** `Header: value`-style part headers, e.g. `content-type: image/png`. */
function headerValue(headers: string, name: string): string | null {
  const m = headers.match(new RegExp(`^${name}:([^\\r\\n]*)`, 'im'));
  return m ? (m[1] ?? '').trim() : null;
}

type Part =
  | { mode: 'text'; name: string; text: string[] }
  | { mode: 'file'; name: string; fd: number; size: number; path: string; filename: string; mime: string };

/**
 * Stream one multipart body. The first part named in `fileFields` (that carries a filename) is
 * staged to `tmpDir` at 0600 under the byte cap; every other part is collected as a text field.
 * `UserError` 413 is thrown the moment the staged file would exceed `cap`, cancelling the stream.
 * The caller owns — and must unlink — the staged file named in the result.
 */
export async function parseMultipartCapped(
  stream: ReadableStream<Uint8Array>,
  contentType: string | null | undefined,
  cap: number,
  fileFields: string[],
  tmpDir: string,
): Promise<MultipartResult> {
  const boundary = boundaryFrom(contentType);
  const opener = te.encode(`--${boundary}`);
  const delim = te.encode(`\r\n--${boundary}`);
  const crlf2 = te.encode('\r\n\r\n');
  const fields: Record<string, string> = {};
  let file: MultipartStaged | null = null;

  if (!stream) bad('send the upload as multipart form data');
  const reader = stream.getReader();
  let buf: Uint8Array = new Uint8Array(0);
  let state: 'opener' | 'headers' | 'data' | 'after-delim' = 'opener';
  let done = false;
  let part: Part | null = null;

  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  /** Failure-path teardown: close the staged file and delete it. */
  const cleanupFail = () => {
    if (part?.mode === 'file') {
      try {
        closeSync(part.fd);
      } catch {}
      rmSync(part.path, { force: true });
    }
    part = null;
  };

  /** Normal close-out: text parts commit to `fields`; the file part keeps its staged file. */
  const finishPart = () => {
    const p = part;
    part = null;
    if (!p) return;
    if (p.mode === 'text') fields[p.name] = p.text.join('');
    else {
      closeSync(p.fd);
      file = { path: p.path, size: p.size, filename: p.filename, mime: p.mime };
    }
  };

  const deliver = (chunk: Uint8Array) => {
    if (!part || chunk.length === 0) return;
    if (part.mode === 'text') {
      if (part.text.join('').length + chunk.length > FIELD_CAP) bad('form fields are too long');
      part.text.push(dec.decode(chunk));
      return;
    }
    part.size += chunk.length;
    if (part.size > cap) {
      reader.cancel().catch(() => {});
      cleanupFail();
      throw new UserError(`files are limited to ${Math.max(1, Math.round(cap / 1024 / 1024))} MB`, 413);
    }
    writeSync(part.fd, chunk);
  };

  try {
    for (;;) {
      // Advance the state machine as far as the buffered bytes allow.
      let progressed = true;
      while (progressed && !done) {
        progressed = false;
        if (state === 'opener') {
          const i = indexOf(buf, opener);
          if (i === -1) {
            if (buf.length > opener.length + 256) bad('upload ended early');
            break;
          }
          buf = buf.subarray(i + opener.length);
          state = 'headers';
          progressed = true;
          continue;
        }
        if (state === 'headers') {
          const i = indexOf(buf, crlf2);
          if (i === -1) {
            if (buf.length > HEADER_CAP) bad('upload headers are too long');
            break;
          }
          const headers = dec.decode(buf.subarray(0, i)).toLowerCase();
          buf = buf.subarray(i + 4);
          const name = String(headerAttr(headers, 'name') ?? '');
          if (!name) bad('upload ended early');
          const filename = headerAttr(headers, 'filename');
          if (fileFields.includes(name) && filename !== null) {
            const path = join(tmpDir, `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
            part = { mode: 'file', name, fd: openSync(path, 'w', 0o600), size: 0, path, filename, mime: headerValue(headers, 'content-type') ?? '' };
          } else {
            part = { mode: 'text', name, text: [] };
          }
          state = 'data';
          progressed = true;
          continue;
        }
        if (state === 'data') {
          const i = indexOf(buf, delim);
          if (i === -1) {
            // Emit everything that cannot be part of a delimiter; hold the last delim.length-1 bytes.
            const keep = delim.length - 1;
            if (buf.length > keep) {
              deliver(buf.subarray(0, buf.length - keep));
              buf = buf.subarray(buf.length - keep);
            }
            break;
          }
          deliver(buf.subarray(0, i));
          buf = buf.subarray(i + delim.length);
          finishPart();
          state = 'after-delim';
          progressed = true;
          continue;
        }
        // state === 'after-delim': `--` closes the body; otherwise padding, CRLF, next part.
        if (buf.length === 0) break;
        if (buf[0] === 45) {
          if (buf.length < 2) break; // one dash: wait for the second
          if (buf[1] === 45) {
            done = true;
            break;
          }
          bad('upload ended early');
        }
        let pad = 0;
        while (pad < buf.length && (buf[pad] === 32 || buf[pad] === 9)) pad++;
        if (pad > 0) {
          buf = buf.subarray(pad);
          progressed = true;
          continue;
        }
        if (buf[0] === 13 || buf[0] === 10) {
          if (buf[0] === 13 && buf.length < 2) break; // could be half a CRLF
          const step = buf[0] === 13 && buf[1] === 10 ? 2 : 1;
          buf = buf.subarray(step);
          state = 'headers';
          progressed = true;
          continue;
        }
        bad('upload ended early');
      }
      if (done) break;
      const { value, done: eof } = await reader.read();
      if (eof) {
        if (!done) bad('upload ended early');
        break;
      }
      if (value && value.length) buf = concat(buf, value);
      // No delimiter anywhere in a buffer this large: junk, refuse instead of buffering forever.
      if (buf.length > cap + HEADER_CAP + 4096) {
        reader.cancel().catch(() => {});
        bad('upload ended early');
      }
    }
  } catch (e) {
    if (!(e instanceof UserError)) {
      reader.cancel().catch(() => {});
      cleanupFail();
    } else if (part) {
      cleanupFail();
    }
    throw e;
  }
  return { fields, file };
}
