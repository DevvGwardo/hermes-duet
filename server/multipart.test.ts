import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMultipartCapped } from './multipart';

const enc = (s: string) => new TextEncoder().encode(s);
const tmpDir = () => mkdtempSync(join(tmpdir(), 'multipart-test-'));

/** Build a multipart body the way a browser would: text fields, then one file part (`partName` names the file field). */
function multipartBody(boundary: string, file: { name: string; type: string; data: Uint8Array } & { partName?: string }, fields: Record<string, string> = {}): Uint8Array {
  const head = (extra: string) => `--${boundary}\r\n${extra}\r\n\r\n`;
  const chunks: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(enc(head(`content-disposition: form-data; name="${k}"`) + v + '\r\n'));
  chunks.push(enc(head(`content-disposition: form-data; name="${file.partName ?? 'file'}"; filename="${file.name}"\r\ncontent-type: ${file.type}`)));
  chunks.push(file.data);
  chunks.push(enc(`\r\n--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
/** A stream that yields the body in `size`-byte chunks; records cancellation. */
function stream(body: Uint8Array, size = 1) {
  let cancelled = false;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= body.length) controller.close();
      else {
        controller.enqueue(body.subarray(i, i + size));
        i += size;
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, get cancelled() { return cancelled; } };
}

const CT = 'multipart/form-data; boundary=XBOUND';

describe('parseMultipartCapped', () => {
  test('round-trips a file part and text fields', async () => {
    const body = multipartBody('XBOUND', { name: 'a.png', type: 'image/png', data: new Uint8Array([1, 2, 3, 0xff]) }, { mime: 'image/png', label: 'receipt' });
    const s = stream(body, 7);
    const tmp = tmpDir();
    try {
      const out = await parseMultipartCapped(s.stream, CT, 1024, ['file'], tmp);
      expect(out.fields.mime).toBe('image/png');
      expect(out.fields.label).toBe('receipt');
      expect(out.file?.filename).toBe('a.png');
      expect(out.file?.mime).toBe('image/png');
      expect(Array.from(readFileSync(out.file!.path))).toEqual([1, 2, 3, 0xff]);
      expect(s.cancelled).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('survives one-byte chunks (boundary split across reads)', async () => {
    const body = multipartBody('XBOUND', { name: 'x.bin', type: 'application/octet-stream', data: enc('hello') }, { note: 'chunked' });
    const tmp = tmpDir();
    try {
      const out = await parseMultipartCapped(stream(body, 1).stream, CT, 1024, ['file'], tmp);
      expect(out.fields.note).toBe('chunked');
      expect(new TextDecoder().decode(readFileSync(out.file!.path))).toBe('hello');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stops at the cap, cancels the stream, and never sees the rest', async () => {
    const big = new Uint8Array(3000).fill(7);
    const body = multipartBody('XBOUND', { name: 'big.bin', type: 'application/octet-stream', data: big });
    const s = stream(body, 16);
    const tmp = tmpDir();
    try {
      expect(async () => {
        await parseMultipartCapped(s.stream, CT, 1024, ['file'], tmp);
      }).toThrow(/limited to/);
      expect(s.cancelled).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing boundary in content-type is refused', async () => {
    const body = multipartBody('XBOUND', { name: 'a', type: 'text/plain', data: enc('hi') });
    const tmp = tmpDir();
    try {
      expect(async () => {
        await parseMultipartCapped(stream(body).stream, 'multipart/form-data', 100, ['file'], tmp);
      }).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no matching file field leaves file null but keeps fields', async () => {
    const body = multipartBody('XBOUND', { name: 'other.bin', partName: 'other', type: 'text/plain', data: enc('nope') }, { q: 'v' });
    const tmp = tmpDir();
    try {
      const out = await parseMultipartCapped(stream(body, 3).stream, CT, 100, ['file'], tmp);
      expect(out.file).toBeNull();
      expect(out.fields.q).toBe('v');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves filename/field casing, attribute order, and chunked UTF-8 text fields', async () => {
    const body = enc(
      `--XBOUND\r\ncontent-disposition: form-data; filename="Receipt.PDF"; name="FilePart"\r\ncontent-type: Image/PNG\r\n\r\nPNGDATA\r\n` +
        `--XBOUND\r\ncontent-disposition: form-data; name="Greeting"\r\n\r\nHello 🚀 World\r\n--XBOUND--\r\n`,
    );
    const tmp = tmpDir();
    try {
      const out = await parseMultipartCapped(stream(body, 2).stream, CT, 1024, ['FilePart'], tmp);
      expect(out.file?.filename).toBe('Receipt.PDF');
      expect(out.file?.mime).toBe('image/png');
      expect(out.fields.Greeting).toBe('Hello 🚀 World');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects a second file part and cleans up the already-staged first file', async () => {
    const body = enc(
      `--XBOUND\r\ncontent-disposition: form-data; name="file"; filename="first.png"\r\ncontent-type: image/png\r\n\r\nFIRST\r\n` +
        `--XBOUND\r\ncontent-disposition: form-data; name="file"; filename="second.png"\r\ncontent-type: image/png\r\n\r\nSECOND\r\n--XBOUND--\r\n`,
    );
    const s = stream(body, 8);
    const tmp = tmpDir();
    try {
      await expect(parseMultipartCapped(s.stream, CT, 1024, ['file'], tmp)).rejects.toThrow(/one file/);
      expect(readdirSync(tmp)).toEqual([]);
      expect(s.cancelled).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cleans up an already-completed staged file if a trailing part fails', async () => {
    const bigField = 'x'.repeat(9000);
    const body = enc(
      `--XBOUND\r\ncontent-disposition: form-data; name="file"; filename="ok.png"\r\ncontent-type: image/png\r\n\r\nOK\r\n` +
        `--XBOUND\r\ncontent-disposition: form-data; name="note"\r\n\r\n${bigField}\r\n--XBOUND--\r\n`,
    );
    const tmp = tmpDir();
    try {
      await expect(parseMultipartCapped(stream(body, 32).stream, CT, 16_384, ['file'], tmp)).rejects.toThrow();
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('caps cumulative text+file payload across multiple parts at cap', async () => {
    const body = enc(
      `--XBOUND\r\ncontent-disposition: form-data; name="a"\r\n\r\n${'a'.repeat(600)}\r\n` +
        `--XBOUND\r\ncontent-disposition: form-data; name="b"\r\n\r\n${'b'.repeat(600)}\r\n--XBOUND--\r\n`,
    );
    const s = stream(body, 64);
    const tmp = tmpDir();
    try {
      await expect(parseMultipartCapped(s.stream, CT, 1024, ['file'], tmp)).rejects.toThrow(/limited to/);
      expect(s.cancelled).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
