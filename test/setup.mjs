/**
 * Gives the test suite its own data directory, before anything else runs.
 *
 * Loaded with `node --import` (see the "test" script in package.json), so
 * this runs — and MIRROR_DATA_DIR is set — before any test file, and before
 * any module it imports, gets a chance to load. src/config.js and the other
 * modules that build a path under data/ (src/data-dir.js) all read this
 * variable, so every test in the suite writes into a throwaway directory
 * rather than the developer's real data/config.json.
 *
 * `node --test` runs each test file in its own child process; `--import`
 * flags are inherited by those children, so this hook runs again in each one
 * (confirmed by hand — see the commit this file was added in). Each gets a
 * fresh temp directory unless MIRROR_DATA_DIR is already set in the parent
 * environment, in which case every process shares that one instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.MIRROR_DATA_DIR) {
  process.env.MIRROR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'));
}
