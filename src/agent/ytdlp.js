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

import { DATA_DIR, ROOT_DIR } from '../paths.js';

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
/**
 * Where a cookies file would be, if the host needs one.
 *
 * YouTube answers a datacenter address with "Sign in to confirm you're not a
 * bot" no matter which client yt-dlp pretends to be, and PO tokens alone do
 * not change that (measured 2026-09-04 from a Hetzner server). Cookies from a
 * signed-in browser do. They are personal and expire, so they are never in
 * the repository or the image: a Netscape-format file dropped into data/ is
 * picked up on the next request, and its absence changes nothing.
 */
export const COOKIES_PATH = path.join(DATA_DIR, 'youtube-cookies.txt');

/** The arguments every yt-dlp call shares, cookies included when present. */
export function commonArgs({ cookiesPath = COOKIES_PATH } = {}) {
  const args = ['--no-warnings', '--no-playlist'];
  if (fs.existsSync(cookiesPath)) args.push('--cookies', cookiesPath);
  return args;
}

/** YouTube refusing to serve this address, as opposed to nothing matching. */
export const blockedByYouTube = (message) =>
  /sign in to confirm|not a bot|cookies-from-browser/i.test(String(message ?? ''));

const PRINT = '%(title)s\n%(duration)s\n%(webpage_url)s';

async function lookup(bin, target, { timeoutMs, exec, cookiesPath }) {
  const { stdout } = await exec(
    bin,
    [...commonArgs({ cookiesPath }), '-f', 'bestaudio', '--print', PRINT, target],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
  );
  const [title, duration, url] = stdout.trim().split('\n');
  if (!title || !url) throw new Error('Nothing found for that.');
  return { title, seconds: Number(duration) || 0, url };
}

/**
 * A query becomes a track: a URL as it is, anything else as a search.
 *
 * YouTube first, because that is where the music is. When YouTube refuses
 * the address rather than failing to find the song, the same search goes to
 * SoundCloud, which serves datacenter addresses without asking who is
 * asking. The caller learns which source answered, and the model is told the
 * real title either way. A URL is never retried elsewhere: the person named a
 * page, and a different page is not what they asked for.
 */
export async function resolveTrack(
  query,
  { timeoutMs = 25_000, exec = run, cookiesPath = COOKIES_PATH, binary } = {},
) {
  const bin = binary ?? (await ensureYtDlp());
  const wanted = query.trim();
  const opts = { timeoutMs, exec, cookiesPath };
  if (/^https?:\/\//i.test(wanted)) {
    try {
      return { ...(await lookup(bin, wanted, opts)), source: 'url' };
    } catch (err) {
      if (blockedByYouTube(err.message)) {
        throw new Error(
          'YouTube is refusing this server. A cookies file in data/ fixes that; see docs/configuration.md.',
          { cause: err },
        );
      }
      throw err;
    }
  }
  try {
    return { ...(await lookup(bin, `ytsearch1:${wanted}`, opts)), source: 'youtube' };
  } catch (err) {
    if (!blockedByYouTube(err.message)) throw err;
    console.warn('[music] YouTube refused this server; searching SoundCloud instead');
    return { ...(await lookup(bin, `scsearch1:${wanted}`, opts)), source: 'soundcloud' };
  }
}
