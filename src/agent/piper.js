/**
 * Piper: a speech synthesiser that runs on this machine.
 *
 * Worth having as an option for two reasons, and speed is only the second one.
 * Measured against the cloud on the same sentence, Piper produced its first
 * audio in ~500ms against ~1120ms — but more importantly it did it in 692,
 * 703 and 723ms across runs, where the API ranged from 1.1s to 4.1s. A
 * predictable wait feels better than one that is sometimes quick.
 *
 * It also costs nothing per use, which matters once the agent is answering all
 * evening.
 *
 * The binary and voices are downloaded into `runtime/`, the same place the
 * launcher already puts a private copy of Node — nothing is installed
 * system-wide, and deleting the folder leaves no trace.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ROOT_DIR } from '../paths.js';

const RUNTIME_DIR = path.join(ROOT_DIR, 'runtime');
const PIPER_DIR = path.join(RUNTIME_DIR, 'piper');
const VOICES_DIR = path.join(RUNTIME_DIR, 'voices');

const PIPER_VERSION = '2023.11.14-2';
const PIPER_RELEASES = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}`;
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main';

/**
 * A deliberately short list.
 *
 * Measured first-audio latency on the dev laptop, same sentence: davefx 0.48s,
 * daniela 1.82s, OpenAI 2.65s. The "high" quality Argentine voice is the slow
 * one of the two local options but still beats the cloud — the accent doesn't
 * have to be given up for speed after all.
 */
export const VOICES = {
  'es_ES-davefx-medium': {
    path: 'es/es_ES/davefx/medium/es_ES-davefx-medium',
    label: 'Español (España) — rápida',
    note: 'La más rápida. Acento peninsular.',
    sampleRate: 22050,
  },
  'en_US-lessac-medium': {
    path: 'en/en_US/lessac/medium/en_US-lessac-medium',
    label: 'English (US) — fast',
    note: 'Fast. Use when the channel speaks English.',
    sampleRate: 22050,
  },
  'es_AR-daniela-high': {
    path: 'es/es_AR/daniela/high/es_AR-daniela-high',
    label: 'Español (Argentina)',
    note: 'Acento rioplatense. ~1.8s: más lenta que davefx, más rápida que la nube.',
    sampleRate: 22050,
  },
};

export const DEFAULT_VOICE = 'es_ES-davefx-medium';

function platformAsset() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'linux' && arch === 'x64') return 'piper_linux_x86_64.tar.gz';
  if (platform === 'linux' && arch === 'arm64') return 'piper_linux_aarch64.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'piper_macos_x64.tar.gz';
  if (platform === 'darwin' && arch === 'arm64') return 'piper_macos_aarch64.tar.gz';
  if (platform === 'win32') return 'piper_windows_amd64.zip';
  return null;
}

export function piperBinary() {
  return path.join(PIPER_DIR, os.platform() === 'win32' ? 'piper.exe' : 'piper');
}

export function isPiperInstalled() {
  try {
    fs.accessSync(piperBinary(), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function isVoiceInstalled(name) {
  return fs.existsSync(path.join(VOICES_DIR, `${name}.onnx`));
}

/** Shared so concurrent callers wait on one download instead of racing it. */
const inFlight = new Map();

async function download(url, target) {
  if (fs.existsSync(target)) return target;
  if (inFlight.has(target)) return inFlight.get(target);

  const job = (async () => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Rename into place, so a half-written file is never mistaken for a
    // finished one — a partially downloaded model loads as a hard failure.
    const partial = `${target}.part`;
    fs.writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(partial, target);
    return target;
  })().finally(() => inFlight.delete(target));

  inFlight.set(target, job);
  return job;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', ...options });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

/** Fetch and unpack the Piper binary if it isn't already there. */
let installing = null;

export async function ensurePiper() {
  if (isPiperInstalled()) return piperBinary();
  installing ??= installPiper().finally(() => {
    installing = null;
  });
  return installing;
}

async function installPiper() {

  const asset = platformAsset();
  if (!asset) {
    throw new Error(`No Piper build for ${os.platform()}/${os.arch()}. Use the OpenAI voice instead.`);
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const archive = path.join(RUNTIME_DIR, asset);

  console.log(`[piper] downloading ${asset}…`);
  await download(`${PIPER_RELEASES}/${asset}`, archive);

  if (asset.endsWith('.zip')) {
    // Windows 10+ ships PowerShell; there's no zip reader in Node's stdlib.
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${RUNTIME_DIR}' -Force`,
    ]);
  } else {
    await run('tar', ['xzf', archive, '-C', RUNTIME_DIR]);
  }

  fs.rmSync(archive, { force: true });
  if (!isPiperInstalled()) throw new Error('Piper unpacked but the binary is missing.');

  fs.chmodSync(piperBinary(), 0o755);
  console.log('[piper] ready');
  return piperBinary();
}

/** Fetch a voice model if it isn't already there. Roughly 60MB for a medium voice. */
export async function ensureVoice(name) {
  const voice = VOICES[name];
  if (!voice) throw new Error(`Unknown voice: ${name}`);

  const onnx = path.join(VOICES_DIR, `${name}.onnx`);
  if (fs.existsSync(onnx)) return onnx;

  console.log(`[piper] downloading voice ${name}…`);
  await download(`${VOICE_BASE}/${voice.path}.onnx`, onnx);
  await download(`${VOICE_BASE}/${voice.path}.onnx.json`, `${onnx}.json`);
  console.log(`[piper] voice ${name} ready`);
  return onnx;
}

/**
 * Speak text, returning a stream of Ogg Opus ready for Discord.
 *
 * Piper emits raw 22kHz mono PCM; ffmpeg resamples and encodes. Both are
 * spawned as a pipeline rather than buffered, so audio starts flowing before
 * the sentence has finished synthesising.
 */
export function speak(text, { binary, model, ffmpeg, sampleRate = 22050 }) {
  const piper = spawn(binary, ['--model', model, '--output-raw'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: {
      ...process.env,
      // The release ships its own shared libraries next to the binary.
      LD_LIBRARY_PATH: `${PIPER_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`,
      DYLD_LIBRARY_PATH: `${PIPER_DIR}:${process.env.DYLD_LIBRARY_PATH ?? ''}`,
    },
  });

  const encoder = spawn(
    ffmpeg,
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '64k',
      '-f', 'ogg', 'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );

  piper.stdout.pipe(encoder.stdin);
  piper.stdin.end(`${text}\n`);

  // Don't let a dead child hang the stream open.
  const fail = (err) => encoder.stdout.destroy(err);
  piper.on('error', fail);
  encoder.on('error', fail);

  return encoder.stdout;
}

export { PIPER_DIR, VOICES_DIR };
