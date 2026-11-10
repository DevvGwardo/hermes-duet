// Saving an edited deliverable as a new version. The original file is left untouched; the new one joins its
// version chain (`FileEntry.version_of`) and inherits the task/page links, so lists that already pick the
// newest version of a page keep working.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isEditableMime, MAX_EDIT_BYTES } from '../shared/edit';
import type { FileEntry } from '../shared/types';
import { config } from './config';
import { files, newId } from './db';
import { UserError } from './errors';

/**
 * Write `text` as a new version of `original` and register it. Throws a UserError (400) for a file that is not
 * text-editable and a 413 over the size cap; the route turns those into the response.
 */
export function saveFileVersion(original: FileEntry, text: string): FileEntry {
  if (!isEditableMime(original.name, original.mime)) {
    throw new UserError(`can't edit ${original.name}: only text files can be edited`);
  }
  const size = Buffer.byteLength(text, 'utf8');
  if (size > MAX_EDIT_BYTES) {
    throw new UserError(`edited files are limited to ${MAX_EDIT_BYTES / 1024 / 1024} MB`, 413);
  }
  const id = newId();
  const dir = join(config.dataDir, 'files', id);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(original.name) || `${id}.txt`);
  // Write to a sibling temp name, then rename: a reader (or a rebuild mid-write) never sees half a version.
  const tmp = join(dir, `.${id}.tmp`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const entry: FileEntry = {
    id,
    title: original.title,
    name: original.name,
    mime: original.mime,
    size,
    version_of: original.id,
    created_at: Date.now(),
  };
  // Same task and standing page as the file it came from, when it had them.
  if (original.task_id != null) entry.task_id = original.task_id;
  if (original.page_id) entry.page_id = original.page_id;
  return files.add(entry, dest);
}
