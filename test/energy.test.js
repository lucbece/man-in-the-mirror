import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import OpusScript from 'opusscript';

import { DEFAULT_GATE_DB, describeEnergy, gateThreshold, measureEnergy, tooQuiet } from '../src/agent/energy.js';
import { transcribeUtterance, onlyTheNames, hearsAName } from '../src/agent/stt.js';
import { takeTimeouts, withDeadline } from '../src/agent/deadline.js';
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
    const r = await transcribeUtterance(u, gpt4o('Espejo, ¿qué hora es?'));
    assert.equal(r.spoken, true);
    assert.equal(second.calls, 0);
  });

  test('whisper-1 as the first opinion asks nobody', async () => {
    const second = whisper('x');
    const u = utteranceOf(9000);
    u.secondOpinion = () => second;
    const r = await transcribeUtterance(u, { label: 'fake whisper', model: 'whisper-1', async transcribe() { return 'espejo'; } });
    assert.equal(r.spoken, true);
    assert.equal(second.calls, 0);
  });

  test('a failed second opinion leaves the first standing', async (t) => {
    const names = config.values.agentNames;
    config.values.agentNames = 'mirror, espejo';
    t.after(() => { config.values.agentNames = names; });
    const u = utteranceOf(9000);
    u.secondOpinion = () => ({ async transcribe() { throw new Error('network'); } });
    const r = await transcribeUtterance(u, gpt4o('espejo'));
    assert.equal(r.spoken, true);
  });

  /**
   * A stand-in for whisper-1 that never answers, but — like the real
   * `OpenAiWhisper.transcribe` — honours the deadlineMs/retries/stage it is
   * given rather than hanging outright, so it exercises the same wiring a
   * real hung request would.
   */
  function neverAnswers() {
    const tries = { count: 0 };
    return {
      tries,
      async transcribe(wav, { deadlineMs, retries, stage }) {
        return withDeadline(stage, deadlineMs, (signal) => {
          tries.count += 1;
          // Like a real fetch, this only settles once the deadline aborts it
          // — withDeadline's timer fires abort(), but nothing rejects the
          // in-flight call unless it is listening for that itself.
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }, { retries });
      },
    };
  }

  test('a second opinion that never answers does not hold up the wake for two deadlines', async (t) => {
    // This is the bug: the confirmation inherited the primary's own ~4.2s
    // deadline and its one retry, so a hung whisper-1 cost two of those in
    // series (8-11s wakes in production). It must now give up after its own,
    // much shorter, single-shot deadline.
    //
    // SECOND_OPINION_MS is a module constant, so the test overrides it through
    // `utterance.secondOpinionDeadlineMs` — the same seam runTranscription
    // already reads `secondOpinion` through — rather than mutating the export.
    const names = config.values.agentNames;
    config.values.agentNames = 'mirror, espejo';
    t.after(() => { config.values.agentNames = names; });

    const u = utteranceOf(9000);
    u.secondOpinionDeadlineMs = 30;
    const second = neverAnswers();
    u.secondOpinion = () => second;

    const started = Date.now();
    const r = await transcribeUtterance(u, gpt4o('espejo'));
    const elapsed = Date.now() - started;

    assert.equal(r.spoken, true, 'the primary text stands once the confirmation times out');
    assert.equal(u.text, 'espejo');
    assert.equal(second.tries.count, 1, 'retries: 0 — one attempt, not the primary\'s one retry');
    assert.ok(elapsed < 200, `took ${elapsed}ms — a single ~30ms deadline, not two, and not the primary's ~4.2s one`);
  });

  test('a timed-out confirmation is tallied as stt-confirm, not stt', async (t) => {
    const names = config.values.agentNames;
    config.values.agentNames = 'mirror, espejo';
    t.after(() => { config.values.agentNames = names; });
    takeTimeouts(); // clear whatever the previous test left

    const u = utteranceOf(9000);
    u.secondOpinionDeadlineMs = 20;
    u.secondOpinion = () => neverAnswers();

    await transcribeUtterance(u, gpt4o('espejo'));

    assert.deepEqual(takeTimeouts(), { 'stt-confirm': 1 });
  });

  test('what counts as a name', () => {
    assert.equal(onlyTheNames('Espejo.', 'mirror, espejo'), true);
    assert.equal(onlyTheNames('Espejo, ¿qué hora es?', 'mirror, espejo'), false);
    assert.equal(hearsAName('Espejo.', 'mirror, espejo'), true);
    assert.equal(hearsAName('Subtítulos realizados por la comunidad de Amara.org', 'mirror, espejo'), false);
  });
});
