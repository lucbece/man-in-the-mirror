import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..');
export const SOUNDS_DIR = path.join(ROOT_DIR, 'sounds');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
