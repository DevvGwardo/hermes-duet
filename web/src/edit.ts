// Editing deliverables on the phone. DOM-free, so the rule and the list filter can be tested with bun test.
import type { FileEntry } from '../../shared/types';

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
