// Writes a short placeholder clip into sounds/ so playback can be verified
// before any real samples exist. Delete it once you have the good stuff.
import fs from 'node:fs';
import path from 'node:path';

import { SOUNDS_DIR } from '../src/paths.js';

const SAMPLE_RATE = 44100;
const DURATION = 0.9;
const OUT = path.join(SOUNDS_DIR, '00-test-tone.wav');

const frames = Math.floor(SAMPLE_RATE * DURATION);
const data = Buffer.alloc(frames * 2);

for (let i = 0; i < frames; i++) {
  const t = i / SAMPLE_RATE;
  // Two quick chirps, roughly "hee-hee" shaped.
  const chirp = t < 0.4 ? 1 : t > 0.5 && t < 0.9 ? 1 : 0;
  const freq = t < 0.45 ? 660 : 880;
  const envelope = Math.exp(-6 * (t % 0.5));
  const sample = Math.sin(2 * Math.PI * freq * t) * envelope * chirp * 0.4;
  data.writeInt16LE(Math.round(sample * 32767), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // format: PCM
header.writeUInt16LE(1, 22); // channels
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits per sample
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

fs.mkdirSync(SOUNDS_DIR, { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, data]));
console.log(`Wrote ${OUT}`);
