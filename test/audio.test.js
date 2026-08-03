import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import OpusScript from 'opusscript';

import { decodeToMono16k, packetsToWav, TARGET_RATE } from '../src/agent/audio.js';

const DISCORD_RATE = 48_000;
const CHANNELS = 2;
const FRAME = 960; // 20ms, which is what Discord sends

/** Encode a tone the way Discord would, so we can decode it back. */
function toneAsOpusPackets({ hz = 440, frames = 50, amplitude = 12_000 } = {}) {
  const encoder = new OpusScript(DISCORD_RATE, CHANNELS, OpusScript.Application.AUDIO);
  const packets = [];

  for (let f = 0; f < frames; f++) {
    const pcm = Buffer.alloc(FRAME * CHANNELS * 2);
    for (let i = 0; i < FRAME; i++) {
      const t = (f * FRAME + i) / DISCORD_RATE;
      const sample = Math.round(Math.sin(2 * Math.PI * hz * t) * amplitude);
      pcm.writeInt16LE(sample, i * CHANNELS * 2);
      pcm.writeInt16LE(sample, i * CHANNELS * 2 + 2);
    }
    packets.push(Buffer.from(encoder.encode(pcm, FRAME)));
  }
  return packets;
}

function analyse(pcm) {
  let peak = 0;
  let sumSquares = 0;
  const samples = pcm.length / 2;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(s));
    sumSquares += s * s;
  }
  return { peak, rms: Math.sqrt(sumSquares / samples), samples };
}

describe('decodeToMono16k', () => {
  test('one second in gives one second out at 16kHz', () => {
    const pcm = decodeToMono16k(toneAsOpusPackets({ frames: 50 }));
    const seconds = analyse(pcm).samples / TARGET_RATE;
    assert.ok(Math.abs(seconds - 1) < 0.05, `expected ~1s, got ${seconds.toFixed(3)}s`);
  });

  test('preserves the signal rather than mangling it', () => {
    const pcm = decodeToMono16k(toneAsOpusPackets({ amplitude: 12_000 }));
    const { peak, rms } = analyse(pcm);

    // A sine wave's RMS is amplitude / sqrt(2). Landing near that is the real
    // check: naive decimation would alias and skew this badly.
    const expectedRms = 12_000 / Math.SQRT2;
    assert.ok(peak > 8_000, `peak too low: ${peak}`);
    assert.ok(
      Math.abs(rms - expectedRms) / expectedRms < 0.15,
      `rms ${Math.round(rms)} is far from the expected ${Math.round(expectedRms)}`,
    );
  });

  test('survives a corrupt packet instead of throwing', () => {
    const packets = toneAsOpusPackets({ frames: 10 });
    packets.splice(5, 0, Buffer.from([0xff, 0xff, 0xff]));
    assert.ok(decodeToMono16k(packets).length > 0);
  });

  test('empty input gives empty output', () => {
    assert.equal(decodeToMono16k([]).length, 0);
  });
});

describe('packetsToWav', () => {
  test('produces a well-formed 16kHz mono WAV', () => {
    const wav = packetsToWav(toneAsOpusPackets({ frames: 25 }));

    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1, 'should be PCM format');
    assert.equal(wav.readUInt16LE(22), 1, 'should be mono');
    assert.equal(wav.readUInt32LE(24), TARGET_RATE);
    assert.equal(wav.readUInt16LE(34), 16, 'should be 16-bit');

    // A wrong data-chunk length is the classic way to produce a file that
    // players accept and transcription silently truncates.
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
  });

  test('stays well under the 25MB upload limit for a full buffer', () => {
    // 16kHz mono 16-bit is 32KB/s, so even ten minutes of solid speech fits.
    const bytesPerSecond = TARGET_RATE * 2;
    assert.ok(bytesPerSecond * 600 < 25 * 1024 * 1024);
  });
});
