import type { FileEntry } from './types';

/**
 * Filter `files` (assumed newest first) for Make's "Your files" / desktop Rail: keeps only the latest
 * version of each standing page and omits pages already shown in `pinned`.
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
