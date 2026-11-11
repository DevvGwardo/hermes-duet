import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The DB holds device tokens, push encryption keys and the VAPID private key.
 * Note: on Windows NTFS, POSIX chmod mode bits are ignored by the filesystem; access control relies on NTFS ACLs.
 */
export function lockDownDataDir(dataDir: string) {
  chmodSync(dataDir, 0o700);
  for (const name of ['duet.db', 'duet.db-wal', 'duet.db-shm']) {
    const path = join(dataDir, name);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}
