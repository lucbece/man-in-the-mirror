/**
 * yt-dlp, fetched on demand like the other runtimes.
 *
 * Same shape as whisper.js and piper.js, and for the same reason: nobody
 * should have to install anything to use a feature they might never touch.
 * It lands in runtime/, which is gitignored and never shipped.
 *
 * Why a binary rather than a library. Every pure-JS YouTube extractor breaks
 * within weeks, because it reimplements a signature scheme that YouTube
 * changes deliberately. yt-dlp is the project that keeps up with that, and
 * updating it is replacing one file rather than waiting for a dependency to
 * catch up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ROOT_DIR } from '../paths.js';

const run = promisify(execFile);
const RUNTIME_DIR = path.join(ROOT_DIR, 'runtime');

/** One release asset per platform. Linux and macOS ship a single binary. */
const ASSETS = {
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'win32-x64': 'yt-dlp.exe',
};

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

export function ytDlpPath() {
  return path.join(RUNTIME_DIR, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

let inFlight = null;

/** The path to a working yt-dlp, downloading it the first time. */
export function ensureYtDlp() {
  const target = ytDlpPath();
  if (fs.existsSync(target)) return Promise.resolve(target);
  // One download even if three people ask for music at once.
  inFlight ??= download(target).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function download(target) {
  const asset = ASSETS[`${os.platform()}-${os.arch()}`];
  if (!asset) {
    throw new Error(`No yt-dlp build for ${os.platform()}/${os.arch()}.`);
  }

  console.log('[music] fetching yt-dlp (first time only)…');
  const res = await fetch(`${RELEASE}/${asset}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download yt-dlp: HTTP ${res.status}`);

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Written beside the target and renamed, so an interrupted download can
  // never leave a half-file that looks installed.
  const partial = `${target}.part`;
  fs.writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(partial, 0o755);
  fs.renameSync(partial, target);

  console.log('[music] yt-dlp ready');
  return target;
}

/**
 * Look a track up without downloading it.
 *
 * Returns the title, how long it is, and a direct audio URL. A bare query
 * becomes a YouTube search; a link is used as given, which is what makes a
 * playlist link work.
 */
export async function resolveTrack(query, { timeoutMs = 25_000 } = {}) {
  const bin = await ensureYtDlp();
  const target = /^https?:\/\//i.test(query.trim()) ? query.trim() : `ytsearch1:${query}`;

  const { stdout } = await run(
    bin,
    [
      '--no-warnings',
      '--no-playlist',
      '-f',
      'bestaudio',
      '--print',
      '%(title)s\n%(duration)s\n%(webpage_url)s',
      target,
    ],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
  );

  const [title, duration, url] = stdout.trim().split('\n');
  if (!title || !url) throw new Error('Nothing found for that.');
  return { title, seconds: Number(duration) || 0, url };
}
