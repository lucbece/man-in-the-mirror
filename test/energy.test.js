import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import OpusScript from 'opusscript';

import { DEFAULT_GATE_DB, describeEnergy, gateThreshold, measureEnergy, tooQuiet } from '../src/agent/energy.js';
import { transcribeUtterance, onlyTheNames, hearsAName } from '../src/agent/stt.js';
import { config } from '../src/config.js';
import { Utterance } from '../src/agent/buffer.js';

/** 16 kHz mono PCM: a sine at the given amplitude, or silence. */
function pcm({ seconds = 1, amplitude = 0, hz = 440 } = {}) {
  const samples = Math.round(16_000 * seconds);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 16_000) * amplitude), i * 2);
  }
  return buf;
}

describe('measuring a clip', () => {
  test('silence is the floor, not minus infinity', () => {
    const e = measureEnergy(pcm({ seconds: 0.5 }));
    assert.equal(e.ms, 500);
    assert.equal(e.peakDb, -100);
    assert.equal(e.rmsDb, -100);
    assert.equal(e.activeRatio, 0);
  });

  test('a voice-sized tone peaks near full scale and is active throughout', () => {
    // 9000 of 32768 is about -11 dBFS, the level the transcription tests use.
    const e = measureEnergy(pcm({ amplitude: 9000 }));
    assert.equal(e.peakDb, -11);
    assert.ok(e.rmsDb > -20 && e.rmsDb < -11, `rms ${e.rmsDb}`);
    assert.equal(e.activeRatio, 1);
  });

  test('a breath-sized rumble peaks far below the gate', () => {
    // 100 of 32768 is about -50 dBFS.
    const e = measureEnergy(pcm({ amplitude: 100 }));
    assert.equal(e.peakDb, -50);
    assert.equal(e.activeRatio, 0);
  });

  test('a word in a quiet clip shows as a short active run', () => {
    const quiet = pcm({ seconds: 0.8, amplitude: 50 });
    const word = pcm({ seconds: 0.2, amplitude: 6000 });
    const e = measureEnergy(Buffer.concat([quiet, word]));
    assert.equal(e.peakDb, -15);
    assert.ok(e.activeRatio > 0.15 && e.activeRatio < 0.3, `active ${e.activeRatio}`);
  });

  test('describes itself the way the log wants it', () => {
    assert.equal(
      describeEnergy({ ms: 1234, peakDb: -18, rmsDb: -31, activeRatio: 0.72 }),
      '1.2s peak -18dB rms -31dB active 72%',
    );
  });
});

describe('the gate', () => {
  test('refuses only what never got loud enough', () => {
    assert.equal(tooQuiet({ peakDb: -50 }, -40), true);
    assert.equal(tooQuiet({ peakDb: -40 }, -40), false);
    assert.equal(tooQuiet({ peakDb: -11 }, -40), false);
  });

  test('reads its threshold from the environment, and can be turned off', () => {
    assert.equal(gateThreshold({}), DEFAULT_GATE_DB);
    assert.equal(gateThreshold({ MIRROR_STT_GATE_DB: '-35' }), -35);
    assert.equal(gateThreshold({ MIRROR_STT_GATE_DB: 'off' }), null);
    assert.equal(gateThreshold({ MIRROR_STT_GATE_DB: 'loud' }), DEFAULT_GATE_DB);
    assert.equal(tooQuiet({ peakDb: -100 }, null), false);
  });
});

describe('in front of the transcriber', () => {
  // Real Opus, because the gate measures what the decoder produces.
  function utteranceOf(amplitude, frames = 50) {
    const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const u = new Utterance({ userId: '1', displayName: 'Vero', startedAt: Date.now() });
    for (let f = 0; f < frames; f += 1) {
      const frame = Buffer.alloc(960 * 2 * 2);
      for (let i = 0; i < 960; i += 1) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * (f * 960 + i)) / 48_000) * amplitude);
        frame.writeInt16LE(sample, i * 4);
        frame.writeInt16LE(sample, i * 4 + 2);
      }
      u.push(Buffer.from(encoder.encode(frame, 960)));
    }
    return u;
  }

  function provider() {
    const calls = [];
    return { label: 'fake', calls, async transcribe(wav) { calls.push(wav.length); return 'hola'; } };
  }

  test('a clip nobody could hear is never sent, and costs nothing', async () => {
    const stt = provider();
    const result = await transcribeUtterance(utteranceOf(0), stt);
    assert.deepEqual(stt.calls, []);
    assert.equal(result.skipped, true);
    assert.equal(result.spoken, false);
  });

  test('a clip with a voice in it is sent, with its numbers kept on the utterance', async () => {
    const stt = provider();
    const u = utteranceOf(9000);
    const result = await transcribeUtterance(u, stt);
    assert.equal(stt.calls.length, 1);
    assert.equal(result.spoken, true);
    assert.ok(u.energy.peakDb > -20, `peak ${u.energy.peakDb}`);
  });
});

describe('a lone name from a GPT-4o transcriber is confirmed by whisper-1', () => {
  function utteranceOf(amplitude, frames = 50) {
    const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
    const u = new Utterance({ userId: 'u1', displayName: 'Vero', startedAt: Date.now() });
    for (let f = 0; f < frames; f += 1) {
      const frame = Buffer.alloc(960 * 2 * 2);
      for (let i = 0; i < 960; i += 1) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * (f * 960 + i)) / 48_000) * amplitude);
        frame.writeInt16LE(sample, i * 4);
        frame.writeInt16LE(sample, i * 4 + 2);
      }
      u.push(Buffer.from(encoder.encode(frame, 960)));
    }
    return u;
  }
  const gpt4o = (says) => ({ label: 'fake gpt-4o', model: 'gpt-4o-transcribe', calls: 0, async transcribe() { this.calls += 1; return says; } });
  const whisper = (says) => ({ calls: 0, async transcribe() { this.calls += 1; return says; } });

  test('kept when whisper-1 hears a name too, dropped when it hears boilerplate', async (t) => {
    const names = config.values.agentNames;
    config.values.agentNames = 'mirror, espejo';
    t.after(() => { config.values.agentNames = names; });

    const agree = whisper('Espejo.');
    const u1 = utteranceOf(9000);
    u1.secondOpinion = () => agree;
    const r1 = await transcribeUtterance(u1, gpt4o('espejo'));
    assert.equal(r1.spoken, true);
    assert.equal(agree.calls, 1);

    const disagree = whisper('Subtítulos realizados por la comunidad de Amara.org');
    const u2 = utteranceOf(9000);
    u2.secondOpinion = () => disagree;
    const r2 = await transcribeUtterance(u2, gpt4o('mirror'));
    assert.equal(r2.spoken, false, 'noise the model named, and the other model did not');
    assert.equal(u2.text, '');
  });

  test('a sentence with the name in it needs no second opinion', async () => {
    const second = whisper('x');
    const u = utteranceOf(9000);
    u.secondOpinion = () => second;
    const r = await transcribeUtterance(u, gpt4o('espejo, qué hora es'));
    assert.equal(r.spoken, true);
    assert.equal(second.calls, 0);
  });

  test('helpers: what counts as only the names, and as hearing one', () => {
    assert.equal(onlyTheNames('Espejo.', 'mirror, espejo'), true);
    assert.equal(onlyTheNames('mirror, espejo', 'mirror, espejo'), true);
    assert.equal(onlyTheNames('espejo qué hora es', 'mirror, espejo'), false);
    assert.equal(hearsAName('espejito', 'mirror, espejo'), true);
    assert.equal(hearsAName('espero', 'mirror, espejo'), true, 'near enough to count as agreement');
    assert.equal(hearsAName('Gracias por ver el video', 'mirror, espejo'), false);
  });
});
