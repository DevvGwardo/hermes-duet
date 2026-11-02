// Runs before every test file. The server modules read their data directory once, at import, so this has to happen
// before any of them load: a test that imports db.ts must never open the developer's real duet.db.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
if (!process.env.DUET_DATA_DIR) process.env.DUET_DATA_DIR = mkdtempSync(join(tmpdir(), 'duet-test-'));
// The scheduler would try to reach Hermes on a timer during the run.
process.env.DUET_DISABLE_SCHEDULER = '1';
// Tests must never reach out to a live Hermes daemon on the machine. This is the guard that does it: port 0 is
// nothing, so any call fails at once instead of waking a real gateway on 8642. (A DUET_DISABLE_HERMES flag used to sit
// here too; nothing ever read it, so it only looked like a guard.)
process.env.DUET_HERMES_URL = 'http://127.0.0.1:0';
