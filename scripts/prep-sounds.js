// Turns raw soundboard downloads into clips that behave well in a voice channel.
//
// Rips from the internet arrive at wildly different loudness, sample rates and
// formats, with dead air on either end. Played back-to-back at random that
// reads as "the bot is broken". This normalises all of it:
//
//   trim silence → loudness-normalise to -16 LUFS → limit → 48kHz stereo Opus
//
// 48kHz stereo is the rate Discord runs at, so nothing gets resampled at
// playback, and Opus keeps the files small. (The volume control still decodes
// to PCM to apply gain, so this isn't a full passthrough.)
//
// Usage:
//   npm run prep                 # incoming/ -> sounds/
//   npm run prep -- some/folder  # custom input folder
//   npm run prep -- --force      # re-process clips already in sounds/
//   npm run prep -- --replace    # delete each source file once converted

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

import { ROOT_DIR, SOUNDS_DIR } from '../src/paths.js';
import { SUPPORTED_EXTENSIONS } from '../src/sounds.js';

const run = promisify(execFile);

const TARGET_LUFS = -16;
const MAX_REASONABLE_SECONDS = 6;
const INCOMING_DIR = path.join(ROOT_DIR, 'incoming');

const FILTERS = [
  // Trim dead air from the front, reverse, trim the new front (the old end), reverse back.
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak',
  'areverse',
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-50dB:detection=peak',
  'areverse',
  `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11`,
  'alimiter=limit=0.95',
  'aresample=48000',
].join(',');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const replace = args.includes('--replace');
  const inputDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? INCOMING_DIR);

  if (!fs.existsSync(inputDir)) {
    fs.mkdirSync(inputDir, { recursive: true });
    console.log(`Created ${rel(inputDir)}`);
    console.log('Drop your raw clips in there and run this again.');
    return;
  }

  const files = fs
    .readdirSync(inputDir, { withFileTypes: true })
    .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(inputDir, e.name));

  if (files.length === 0) {
    console.log(`No audio files in ${rel(inputDir)}.`);
    console.log(`Supported: ${[...SUPPORTED_EXTENSIONS].join(' ')}`);
    return;
  }

  fs.mkdirSync(SOUNDS_DIR, { recursive: true });
  console.log(`Processing ${files.length} file(s) from ${rel(inputDir)}\n`);

  let done = 0;
  let skipped = 0;
  const warnings = [];

  for (const source of files) {
    const name = `${slugify(path.basename(source, path.extname(source)))}.ogg`;
    const target = path.join(SOUNDS_DIR, name);

    if (fs.existsSync(target) && !force) {
      console.log(`  ○ ${name} — already exists (use --force to redo)`);
      skipped++;
      continue;
    }

    try {
      const before = await probeDuration(source);
      await convert(source, target);
      const after = await probeDuration(target);

      const trimmed = before && after ? ` (${before.toFixed(2)}s → ${after.toFixed(2)}s)` : '';
      console.log(`  ✓ ${name}${trimmed}`);

      if (after && after > MAX_REASONABLE_SECONDS) {
        warnings.push(`${name} is ${after.toFixed(1)}s — long clips step on conversation`);
      }
      if (replace) fs.unlinkSync(source);
      done++;
    } catch (err) {
      console.log(`  ✗ ${path.basename(source)} — ${firstLine(err.stderr) || err.message}`);
    }
  }

  console.log(`\n${done} converted, ${skipped} skipped → ${rel(SOUNDS_DIR)}`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
  if (done > 0) console.log('\nThe bot picks these up immediately — no restart needed.');
}

function convert(source, target) {
  return run(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', source,
    '-af', FILTERS,
    '-ac', '2',
    '-c:a', 'libopus',
    '-b:a', '96k',
    // Strip cover art and tags picked up from the source file.
    '-vn',
    '-map_metadata', '-1',
    target,
  ]);
}

/**
 * ffmpeg-static ships no ffprobe, so read the duration off ffmpeg's own report.
 * Invoked with no output file it prints the header and exits non-zero, which is
 * the expected path here — hence stderr coming from either branch.
 */
async function probeDuration(file) {
  let stderr = '';
  try {
    ({ stderr } = await run(ffmpegPath, ['-hide_banner', '-i', file]));
  } catch (err) {
    stderr = err.stderr ?? '';
  }

  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function slugify(name) {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'clip'
  );
}

const rel = (p) => path.relative(ROOT_DIR, p) || '.';
const firstLine = (text) => (text ?? '').trim().split('\n').pop();

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
