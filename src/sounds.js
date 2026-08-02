import fs from 'node:fs';
import path from 'node:path';

import { SOUNDS_DIR } from './paths.js';

const SUPPORTED = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
]);

/**
 * The sound library.
 *
 * Picking is bag-based (draw without replacement, reshuffle when empty) so a
 * short library doesn't repeat the same clip twice in a row — true random
 * *feels* less random than this does.
 */
class SoundLibrary {
  constructor(dir = SOUNDS_DIR) {
    this.dir = dir;
    this.files = [];
    this.bag = [];
    this.lastPlayed = null;
    this.refresh();
  }

  refresh() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[sounds] ${err.message}`);
      fs.mkdirSync(this.dir, { recursive: true });
    }

    const next = entries
      .filter((e) => e.isFile() && SUPPORTED.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const changed =
      next.length !== this.files.length || next.some((n, i) => n !== this.files[i]);
    this.files = next;
    if (changed) this.bag = [];

    return this.files;
  }

  get size() {
    return this.files.length;
  }

  list() {
    return this.files.map((name) => ({
      name,
      path: path.join(this.dir, name),
      sizeBytes: statSize(path.join(this.dir, name)),
    }));
  }

  resolve(name) {
    // Guard against traversal: only accept a bare filename we already know.
    const bare = path.basename(name);
    if (!this.files.includes(bare)) return null;
    return path.join(this.dir, bare);
  }

  /** Draw the next clip. Returns an absolute path, or null if the library is empty. */
  next() {
    if (this.files.length === 0) return null;
    if (this.files.length === 1) {
      this.lastPlayed = this.files[0];
      return path.join(this.dir, this.files[0]);
    }

    if (this.bag.length === 0) this.fillBag();

    const name = this.bag.pop();
    this.lastPlayed = name;
    return path.join(this.dir, name);
  }

  fillBag() {
    const shuffled = shuffle([...this.files]);
    // Avoid an immediate repeat across bag boundaries.
    if (shuffled.length > 1 && shuffled[shuffled.length - 1] === this.lastPlayed) {
      [shuffled[0], shuffled[shuffled.length - 1]] = [
        shuffled[shuffled.length - 1],
        shuffled[0],
      ];
    }
    this.bag = shuffled;
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export const sounds = new SoundLibrary();
export { SUPPORTED as SUPPORTED_EXTENSIONS, SoundLibrary };
