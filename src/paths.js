import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..');

// The data directory itself lives in data-dir.js, not here: it needs to
// notice MIRROR_DATA_DIR, and this module stays the one nothing else depends
// on, so it can't be the one with an environment-dependent answer.
