/**
 * whisper.cpp: transcription that runs on this machine.
 *
 * This sits on the critical path in a way the numbers hide. The reported
 * "heard 0.0s" only means the utterance was already transcribed — the ~1s the
 * API took to do it was spent *before* the bot even realised it had been
 * addressed. Cutting that is worth more than any tuning downstream of it.
 *
 * On a machine with an NVIDIA card this is the single biggest win available:
 * the cloud's ~1s is mostly network, so local inference on a GPU is a fraction
 * of it. On a laptop without one it is the opposite — slower than the API —
 * which is why the build and model are chosen by what the machine actually
 * has rather than by preference.
 *
 * Downloaded into `runtime/`, the same place the launcher keeps its private
 * copy of Node. Nothing installed system-wide.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

import { ROOT_DIR } from '../paths.js';

const RUNTIME_DIR = path.join(ROOT_DIR, 'runtime');
const WHISPER_DIR = path.join(RUNTIME_DIR, 'whisper');
const MODELS_DIR = path.join(RUNTIME_DIR, 'models');

const RELEASE = 'v1.9.1';
const RELEASES = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}`;
const MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Models, cheapest first. The turbo build of large is the one worth having on
 * a GPU: near large-v3 accuracy at a fraction of the compute.
 */
export const MODELS = {
  'ggml-base': { size: '142MB', note: 'Rápido en CPU. Comete errores con acentos y ruido.' },
  'ggml-small': { size: '466MB', note: 'Buen equilibrio si no hay GPU.' },
  'ggml-large-v3-turbo': { size: '1.6GB', note: 'La mejor. Pensada para GPU.' },
};

/** True when an NVIDIA card is present and its driver responds. */
export function hasNvidiaGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], (err, stdout) => {
      resolve(!err && Boolean(stdout.trim()));
    });
  });
}

/** Pick the model that suits the hardware, unless one was chosen explicitly. */
export async function suggestedModel() {
  return (await hasNvidiaGpu()) ? 'ggml-large-v3-turbo' : 'ggml-base';
}

async function platformAsset() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'win32') {
    // The CUDA build is 646MB against 7.6MB, so only fetch it when there is a
    // card to justify it.
    return (await hasNvidiaGpu())
      ? { name: 'whisper-cublas-12.4.0-bin-x64.zip', gpu: true }
      : { name: 'whisper-bin-x64.zip', gpu: false };
  }
  if (platform === 'linux') {
    return {
      name: arch === 'arm64' ? 'whisper-bin-ubuntu-arm64.tar.gz' : 'whisper-bin-ubuntu-x64.tar.gz',
      gpu: false,
    };
  }
  // macOS ships only an xcframework, no CLI — building it is out of scope here.
  return null;
}

export function whisperBinary() {
  const name = os.platform() === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  // The archives nest their contents differently per platform, so find it.
  const stack = [WHISPER_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === name) return full;
    }
  }
  return null;
}

export function isWhisperInstalled() {
  return Boolean(whisperBinary());
}

export function isModelInstalled(name) {
  return fs.existsSync(path.join(MODELS_DIR, `${name}.bin`));
}

async function download(url, target, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} fetching ${label}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

export async function ensureWhisper() {
  const existing = whisperBinary();
  if (existing) return existing;

  const asset = await platformAsset();
  if (!asset) {
    throw new Error(
      `No hay build de whisper.cpp para ${os.platform()}. Usá la transcripción por API.`,
    );
  }

  fs.mkdirSync(WHISPER_DIR, { recursive: true });
  const archive = path.join(RUNTIME_DIR, asset.name);

  console.log(`[whisper] downloading ${asset.name}${asset.gpu ? ' (CUDA build, 646MB)' : ''}…`);
  await download(`${RELEASES}/${asset.name}`, archive, asset.name);

  if (asset.name.endsWith('.zip')) {
    await run('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${WHISPER_DIR}' -Force`,
    ]);
  } else {
    await run('tar', ['xzf', archive, '-C', WHISPER_DIR]);
  }
  fs.rmSync(archive, { force: true });

  const binary = whisperBinary();
  if (!binary) throw new Error('whisper.cpp unpacked but whisper-cli is missing.');
  if (os.platform() !== 'win32') fs.chmodSync(binary, 0o755);

  console.log(`[whisper] ready${asset.gpu ? ' (GPU)' : ''}`);
  return binary;
}

export async function ensureModel(name) {
  if (!MODELS[name]) throw new Error(`Unknown model: ${name}`);
  const target = path.join(MODELS_DIR, `${name}.bin`);
  if (fs.existsSync(target)) return target;

  console.log(`[whisper] downloading model ${name} (${MODELS[name].size})…`);
  await download(`${MODEL_BASE}/${name}.bin`, target, name);
  console.log(`[whisper] model ${name} ready`);
  return target;
}

/**
 * Transcribe a 16kHz mono WAV buffer.
 *
 * whisper-cli reads a file rather than stdin, so the clip goes to a temp file —
 * a couple of hundred kilobytes for an utterance, deleted immediately after.
 */
export function transcribeWav(wav, { binary, model, language }) {
  return new Promise((resolve, reject) => {
    const file = path.join(
      os.tmpdir(),
      `mitm-${crypto.randomBytes(6).toString('hex')}.wav`,
    );
    fs.writeFileSync(file, wav);

    const args = [
      '-m', model,
      '-f', file,
      '-nt', // no timestamps
      '-np', // no progress chatter
      '-l', language || 'auto',
    ];

    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${path.dirname(binary)}:${process.env.LD_LIBRARY_PATH ?? ''}`,
      },
    });

    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', (err) => {
      fs.rmSync(file, { force: true });
      reject(err);
    });
    child.on('close', (code) => {
      fs.rmSync(file, { force: true });
      if (code !== 0) return reject(new Error(`whisper-cli exited ${code}`));
      resolve(out.replace(/\s+/g, ' ').trim());
    });
  });
}

export { WHISPER_DIR, MODELS_DIR };
