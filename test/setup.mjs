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
 * `node --test`'s default process-per-file isolation forks a genuinely new
 * OS process for every test file, and `--import` runs again in each one —
 * confirmed by hand, with a value made fresh on every run rather than a
 * fixed string, which is what a first pass at this check got wrong. Each of
 * those processes gets its *own* temp directory: none of them inherit one
 * set dynamically by a sibling or by this same hook running earlier in a
 * parent, only a MIRROR_DATA_DIR that was already in the environment before
 * `node` itself started (set by hand, or by CI). So a single `npm test` run
 * creates one directory per test file, and each is responsible for cleaning
 * up only the one it made: whichever process actually calls mkdtempSync
 * removes that directory on its own exit, never another process's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.MIRROR_DATA_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-test-'));
  process.env.MIRROR_DATA_DIR = dir;
  process.on('exit', () => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
