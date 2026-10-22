import type { FileEntry } from './types';

/**
 * The files to list in Make's "Your files" or the desktop Rail's "Recent files". A standing page delivers a new file
 * every morning, so listing every one would bury the user's other deliverables under copies of the same page: each
 * page keeps only its newest version, and none at all for the pages in `pinned` (the ones Make already shows under
 * "Every morning"). Older versions stay on disk and still open from the briefs that linked them.
 * `files` is newest first, as the server sends it and the store keeps it.
 */
export function shelf(files: FileEntry[], pinned: string[] = []): FileEntry[] {
  const listed = new Set(pinned);
  return files.filter((f) => {
    if (!f.page_id) return true;
    if (listed.has(f.page_id)) return false;
    listed.add(f.page_id);
    return true;
  });
}
