import { describe, expect, test } from 'bun:test';
import type { FileEntry, Page } from '../../shared/types';
import { isEditableMime, previousPageVersion, visibleFiles } from './edit';

describe('isEditableMime', () => {
  test('text-ish mime types are editable', () => {
    for (const mime of ['text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/plain; charset=utf-8']) {
      expect(isEditableMime('anything.bin', mime)).toBe(true);
    }
  });

  test('json, xml and svg are editable', () => {
    expect(isEditableMime('data.json', 'application/json')).toBe(true);
    expect(isEditableMime('feed', 'application/xml')).toBe(true);
    expect(isEditableMime('icon', 'image/svg+xml')).toBe(true);
  });

  test('the usual document extensions are editable by name, even with a generic mime', () => {
    for (const name of ['notes.md', 'sheet.csv', 'sheet.tsv', 'data.json', 'page.html', 'readme.txt', 'REPORT.MD']) {
      expect(isEditableMime(name, 'application/octet-stream')).toBe(true);
    }
  });

  test('a pdf, a photo or a binary is not editable', () => {
    expect(isEditableMime('scan.pdf', 'application/pdf')).toBe(false);
    expect(isEditableMime('photo.png', 'image/png')).toBe(false);
    expect(isEditableMime('archive.zip', 'application/zip')).toBe(false);
    expect(isEditableMime('program.exe', 'application/octet-stream')).toBe(false);
    expect(isEditableMime('no-extension', '')).toBe(false);
  });
});

const file = (id: string, version_of?: string) => ({ id, title: id, name: `${id}.md`, mime: 'text/markdown', size: 1, created_at: 1, version_of }) as FileEntry;

describe('visibleFiles', () => {
  test('a file the user edited is hidden; the edit is shown', () => {
    const files = [file('original'), file('edit', 'original')];
    expect(visibleFiles(files).map((f) => f.id)).toEqual(['edit']);
  });

  test('a chain of edits keeps only the newest version', () => {
    const files = [file('v1'), file('v2', 'v1'), file('v3', 'v2')];
    expect(visibleFiles(files).map((f) => f.id)).toEqual(['v3']);
  });

  test('unrelated files and independent chains are all kept', () => {
    const files = [file('a'), file('b', 'a'), file('c'), file('d', 'c'), file('plain')];
    expect(visibleFiles(files).map((f) => f.id)).toEqual(['b', 'd', 'plain']);
  });

  test('a version whose earlier file is gone is still shown', () => {
    expect(visibleFiles([file('orphan', 'missing')]).map((f) => f.id)).toEqual(['orphan']);
  });

  test('order is preserved', () => {
    const files = [file('old'), file('new', 'old'), file('middle')];
    expect(visibleFiles(files).map((f) => f.id)).toEqual(['new', 'middle']);
  });
});

describe('previousPageVersion', () => {
  const pageFile = (id: string, created_at: number, opts: { page_id?: string; version_of?: string } = {}) =>
    ({
      id,
      title: id,
      name: `${id}.html`,
      mime: 'text/html',
      size: 1,
      created_at,
      ...opts,
    }) as FileEntry;

  const page = (id: string, file_id: string): Page => ({
    id,
    title: 'Morning page',
    instructions: 'Build it',
    file_id,
    created_at: 1,
    updated_at: 100,
  });

  test('picks the latest scheduled refresh before the current file and excludes manual edits', () => {
    const files = [
      pageFile('day1', 100, { page_id: 'p1' }),
      pageFile('day1-edit', 150, { page_id: 'p1', version_of: 'day1' }),
      pageFile('day2', 200, { page_id: 'p1' }),
      pageFile('day2-edit', 250, { page_id: 'p1', version_of: 'day2' }),
      pageFile('other-page', 190, { page_id: 'p2' }),
    ];
    // Even if page.file_id stayed at day2, day2-edit (manual) is ignored and day1 is returned.
    expect(previousPageVersion(files, page('p1', 'day2'))?.id).toBe('day1');
  });

  test('walks page.file_id version_of chain when page.file_id points at a manual edit', () => {
    const files = [
      pageFile('day1', 100, { page_id: 'p1' }),
      pageFile('day2', 200, { page_id: 'p1' }),
      pageFile('day2-edit1', 210, { page_id: 'p1', version_of: 'day2' }),
      pageFile('day2-edit2', 220, { page_id: 'p1', version_of: 'day2-edit1' }),
    ];
    // Today's page is currently backed by day2-edit2 -> chain covers day2-edit2, day2-edit1, day2; Previous must be day1.
    expect(previousPageVersion(files, page('p1', 'day2-edit2'))?.id).toBe('day1');
  });

  test('returns undefined when no earlier scheduled version exists', () => {
    const files = [
      pageFile('day1', 100, { page_id: 'p1' }),
      pageFile('day1-edit', 150, { page_id: 'p1', version_of: 'day1' }),
    ];
    expect(previousPageVersion(files, page('p1', 'day1-edit'))).toBeUndefined();
    expect(previousPageVersion(files, page('p1', 'day1'))).toBeUndefined();
  });
});
