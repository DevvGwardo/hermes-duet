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
// A developer's .env can carry a real gateway key, and config.ts loads that file at import. With a key present, a
// route test that starts a run tries port 0, fails as "unreachable", and marks Hermes down for the whole shared test
// process, so every later run in another file silently no-ops. Tests that need a key stub hasKey/startRun.
process.env.DUET_HERMES_KEY = '';
process.env.API_SERVER_KEY = '';
