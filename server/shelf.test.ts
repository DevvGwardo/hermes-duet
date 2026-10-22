import { describe, expect, test } from 'bun:test';
import { shelf } from '../shared/shelf';
import type { FileEntry } from '../shared/types';

const file = (id: string, page_id?: string) => ({ id, title: id, name: `${id}.html`, mime: 'text/html', size: 1, created_at: 1, page_id }) as FileEntry;

describe('shelf', () => {
  // Newest first, as the server sends them: two standing pages refreshed three mornings, plus the user's own files.
  const files = [file('dash-3', 'dash'), file('news-3', 'news'), file('deck'), file('dash-2', 'dash'), file('news-2', 'news'), file('notes'), file('dash-1', 'dash')];

  test('each standing page lists only its newest version, between the other files', () => {
    expect(shelf(files).map((f) => f.id)).toEqual(['dash-3', 'news-3', 'deck', 'notes']);
  });

  test('pages already pinned under "Every morning" list no version at all', () => {
    expect(shelf(files, ['dash']).map((f) => f.id)).toEqual(['news-3', 'deck', 'notes']);
    expect(shelf(files, ['dash', 'news']).map((f) => f.id)).toEqual(['deck', 'notes']);
  });

  test('files that were never a page version are all kept', () => {
    const plain = [file('a'), file('b'), file('c')];
    expect(shelf(plain, ['dash'])).toEqual(plain);
  });
});
