// Runs before every test file. The server modules read their data directory once, at import, so this has to happen
// before any of them load: a test that imports db.ts must never open the developer's real duet.db.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.DUET_DATA_DIR) process.env.DUET_DATA_DIR = mkdtempSync(join(tmpdir(), 'duet-test-'));
// The scheduler would try to reach Hermes on a timer during the run.
process.env.DUET_DISABLE_SCHEDULER = '1';
