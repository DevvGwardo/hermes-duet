import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileEntry, Page, ServerEvent } from '../shared/types';
import { sseResponse } from './bus';
import { config } from './config';
import { db, files, newId, pages } from './db';
import { saveFileVersion } from './fileversions';
import { search } from './search';

const createdPageIds: string[] = [];
afterEach(() => {
  while (createdPageIds.length) pages.remove(createdPageIds.pop()!);
});

function createDeliveredFile(name: string, mime: string, text: string, over: Partial<FileEntry> = {}): { entry: FileEntry; path: string } {
  const id = newId();
  const dir = join(config.dataDir, 'files', id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  const entry: FileEntry = {
    id,
    title: over.title ?? name,
    name,
    mime,
    size: Buffer.byteLength(text, 'utf8'),
    created_at: Date.now(),
    ...over,
  };
  files.add(entry, path);
  return { entry, path };
}

function captureEvents(): { events: ServerEvent[]; stop: () => void } {
  const ac = new AbortController();
  const res = sseResponse(new Request('http://127.0.0.1/api/events', { signal: ac.signal }));
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const events: ServerEvent[] = [];
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (;;) {
          const sep = buf.indexOf('\n\n');
          if (sep < 0) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)) as ServerEvent);
            } catch {}
          }
        }
      }
    } catch {}
  })();
  return {
    events,
    stop: () => {
      ac.abort();
      void pump;
    },
  };
}

describe('saveFileVersion', () => {
  test('writes a new linked version on disk and preserves original bytes and task_id', () => {
    const { entry: orig, path: origPath } = createDeliveredFile('notes.md', 'text/markdown', 'initial draft', { task_id: 't-1' });
    const next = saveFileVersion(orig, 'revised draft');

    expect(next.id).not.toBe(orig.id);
    expect(next.version_of).toBe(orig.id);
    expect(next.task_id).toBe('t-1');
    expect(next.title).toBe(orig.title);
    expect(next.name).toBe('notes.md');
    expect(next.mime).toBe('text/markdown');
    expect(next.size).toBe(Buffer.byteLength('revised draft', 'utf8'));

    expect(readFileSync(origPath, 'utf8')).toBe('initial draft');
    const saved = files.get(next.id)!;
    expect(readFileSync(saved.path, 'utf8')).toBe('revised draft');
    expect(existsSync(origPath)).toBe(true);
  });

  test('updates standing page file_id, broadcasts page SSE, and deduplicates file hits in FTS while keeping original for Compare', async () => {
    const token = `standpageuniq${newId()}`;
    const { entry: v1, path: v1Path } = createDeliveredFile('brief-summary.md', 'text/markdown', 'v1 body', {
      title: `Daily digest ${token}`,
      page_id: `page-${newId()}`,
    });
    const page: Page = {
      id: v1.page_id!,
      title: 'Morning Digest',
      instructions: 'Summarize daily priorities.',
      file_id: v1.id,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    pages.save(page);
    createdPageIds.push(page.id);

    const stream = captureEvents();
    try {
      const v2 = saveFileVersion(v1, 'v2 edited body');
      // Wait briefly for ReadableStream microtask enqueue
      await Bun.sleep(10);

      expect(v2.page_id).toBe(page.id);
      const storedPage = pages.get(page.id)!;
      expect(storedPage.file_id).toBe(v2.id);

      const pageEvents = stream.events.filter((e): e is Extract<ServerEvent, { type: 'page' }> => e.type === 'page' && e.page.id === page.id);
      expect(pageEvents.length).toBeGreaterThanOrEqual(1);
      expect(pageEvents.at(-1)!.page.file_id).toBe(v2.id);

      // Search returns only the new version for the file hit, not duplicate file hits.
      const fileHits = search(db, token).filter((h) => h.kind === 'file');
      expect(fileHits.map((h) => h.id)).toEqual([v2.id]);
      // Original file remains readable in files table and on disk for Version Compare.
      expect(files.get(v1.id)?.entry.id).toBe(v1.id);
      expect(readFileSync(v1Path, 'utf8')).toBe('v1 body');
    } finally {
      stream.stop();
    }
  });

  test('does not regress page.file_id or emit a page event when editing an older superseded file version', async () => {
    const pageId = `page-${newId()}`;
    const { entry: v1 } = createDeliveredFile('report.md', 'text/markdown', 'v1', { page_id: pageId });
    const { entry: v2 } = createDeliveredFile('report.md', 'text/markdown', 'v2', { page_id: pageId, version_of: v1.id });
    pages.save({
      id: pageId,
      title: 'Current Report',
      instructions: 'Rebuild daily.',
      file_id: v2.id,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    createdPageIds.push(pageId);

    const stream = captureEvents();
    try {
      const branch = saveFileVersion(v1, 'branched edit from v1');
      await Bun.sleep(10);
      expect(branch.version_of).toBe(v1.id);
      expect(pages.get(pageId)!.file_id).toBe(v2.id);
      expect(stream.events.some((e) => e.type === 'page' && e.page.id === pageId)).toBe(false);
    } finally {
      stream.stop();
    }
  });

  test('refuses binary and oversized files without creating rows or files on disk', () => {
    const { entry: bin } = createDeliveredFile('photo.png', 'image/png', 'png');
    expect(() => saveFileVersion(bin, 'edited')).toThrow('only text files');
    expect(files.all().some((f) => f.version_of === bin.id)).toBe(false);

    const { entry: md } = createDeliveredFile('notes.md', 'text/markdown', 'small');
    expect(() => saveFileVersion(md, 'x'.repeat(2 * 1024 * 1024 + 1))).toThrow('limited');
    expect(files.all().some((f) => f.version_of === md.id)).toBe(false);
  });
});
