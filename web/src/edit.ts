// Editing deliverables on the phone. DOM-free, so the rule and the list filter can be tested with bun test.
import type { FileEntry, Page } from '../../shared/types';

export { isEditableMime, MAX_EDIT_BYTES } from '../../shared/edit';

/**
 * The files a list should show: a file the user edited is replaced by the newest file in its version chain, so
 * "Your files" shows the edit once instead of both copies. The chain is walked to its root because a file can
 * be edited more than once (a version of a version); a dangling `version_of` (the earlier file is gone) keeps
 * the file it points at, since there is nothing newer to show in its place.
 */
export function visibleFiles(files: FileEntry[]): FileEntry[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const superseded = new Set<string>();
  for (const f of files) {
    const seen = new Set<string>([f.id]);
    let previous = f.version_of ? byId.get(f.version_of) : undefined;
    while (previous && !seen.has(previous.id)) {
      seen.add(previous.id);
      superseded.add(previous.id);
      previous = previous.version_of ? byId.get(previous.version_of) : undefined;
    }
  }
  return files.filter((f) => !superseded.has(f.id));
}

/**
 * The previous scheduled refresh version of a standing page for daily Compare: excludes manual edits
 * (`f.version_of`) and skips the version currently backing `page.file_id` (plus its `version_of` chain).
 */
export function previousPageVersion(files: FileEntry[], page: Page): FileEntry | undefined {
  const byId = new Map(files.map((f) => [f.id, f]));
  const currentChain = new Set<string>([page.file_id]);
  let cur = byId.get(page.file_id);
  while (cur?.version_of && !currentChain.has(cur.version_of)) {
    currentChain.add(cur.version_of);
    cur = byId.get(cur.version_of);
  }
  return files
    .filter((f) => f.page_id === page.id && !f.version_of && !currentChain.has(f.id))
    .sort((a, b) => b.created_at - a.created_at)[0];
}
