/**
 * Where the bot's persistent state lives.
 *
 * One override, `MIRROR_DATA_DIR`, and one place that reads it. Everything
 * that used to build a path under `<repo>/data` by hand — the config file,
 * cached filler clips, YouTube cookies, presence, the zomboid SSH keys'
 * default location — calls `dataDir()` / `dataPath()` instead of joining
 * `ROOT_DIR` and `'data'` itself, so there is exactly one thing to change to
 * point the whole bot somewhere else.
 *
 * Unset, nothing changes: `dataDir()` falls back to `ROOT_DIR/data`, same as
 * before this existed. Production never sets the variable — compose mounts
 * the volume at `/app/data`. The test suite does: see `test/setup.mjs`.
 *
 * `dataDir()` reads `process.env` on every call rather than caching it once,
 * so it gives the right answer however early or late a module reads it —
 * including a module loaded before the test runner's `--import` hook has had
 * a chance to set the variable, which a module-level constant would not.
 */
import path from 'node:path';

import { ROOT_DIR } from './paths.js';

export function dataDir() {
  return process.env.MIRROR_DATA_DIR
    ? path.resolve(process.env.MIRROR_DATA_DIR)
    : path.join(ROOT_DIR, 'data');
}

export function dataPath(...segments) {
  return path.join(dataDir(), ...segments);
}
