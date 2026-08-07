import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import OpusScript from 'opusscript';

import { AudioBuffer, Utterance } from '../src/agent/buffer.js';
import { transcribeBuffer, transcribeUtterance } from '../src/agent/stt.js';
import { config } from '../src/config.js';

const DISCORD_RATE = 48_000;
const CHANNELS = 2;
const FRAME = 960;

/** Real Opus, because the transcriber decodes before it does anything else. */
function opusPackets(frames) {
  const encoder = new OpusScript(DISCORD_RATE, CHANNELS, OpusScript.Application.AUDIO);
  const packets = [];
  for (let f = 0; f < frames; f += 1) {
    const pcm = Buffer.alloc(FRAME * CHANNELS * 2);
    for (let i = 0; i < FRAME; i += 1) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * (f * FRAME + i)) / DISCORD_RATE) * 9000);
      pcm.writeInt16LE(sample, i * CHANNELS * 2);
      pcm.writeInt16LE(sample, i * CHANNELS * 2 + 2);
    }
    packets.push(Buffer.from(encoder.encode(pcm, FRAME)));
  }
  return packets;
}

/** An utterance long enough to be worth transcribing. 50 frames is one second. */
function utterance({ frames = 50, displayName = 'Luc' } = {}) {
  const u = new Utterance({ userId: '1', displayName, startedAt: Date.now() });
  for (const packet of opusPackets(frames)) u.push(packet);
  return u;
}

/** A provider that counts its calls and returns whatever it is told to. */
function provider(reply) {
  const calls = [];
  return {
    label: 'fake',
    calls,
    async transcribe(wav, { prompt }) {
      calls.push({ prompt, bytes: wav.length });
      const value = typeof reply === 'function' ? reply(calls.length) : reply;
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

function buffered(...utterances) {
  const buffer = new AudioBuffer({ windowSeconds: 600 });
  for (const u of utterances) buffer.add(u);
  return buffer;
}

describe('the prompt echo, on every path that transcribes', () => {
  test('the on-demand sweep discards Whisper repeating the bot its own names', async () => {
    // This is the bug: transcribeBuffer had its own copy of the logic and the
    // copy had lost echoesPrompt. Whisper handing back the name prompt it was
    // given reads as somebody calling the bot, so the bot answered itself.
    const names = config.get('agentNames');
    const u = utterance();
    const stt = provider(names);

    await transcribeBuffer(buffered(u), { provider: stt });

    assert.equal(u.text, '', `kept "${u.text}" — the echo would wake the bot`);
  });

  test('and so does the eager queue, identically', async () => {
    const u = utterance();
    const stt = provider(config.get('agentNames'));
    const { spoken } = await transcribeUtterance(u, stt);

    assert.equal(spoken, false);
    assert.equal(u.text, '');
  });

  test('real speech still gets through both', async () => {
    const a = utterance();
    const b = utterance();
    await transcribeBuffer(buffered(a), { provider: provider('qué opinás de esto') });
    await transcribeUtterance(b, provider('qué opinás de esto'));

    assert.equal(a.text, 'qué opinás de esto');
    assert.equal(b.text, 'qué opinás de esto');
  });
});

describe('one utterance, one request', () => {
  test('two callers racing on the same utterance send it once', async () => {
    // The eager queue picks an utterance up moments after it is spoken and the
    // on-demand sweep runs the instant a question arrives. Both checked
    // "already transcribed?" before their await, so an utterance cut in that
    // gap was sent — and billed — twice.
    const u = utterance();
    const stt = provider('hola');

    const [first, second] = await Promise.all([
      transcribeUtterance(u, stt),
      transcribeUtterance(u, stt),
    ]);

    assert.equal(stt.calls.length, 1, `sent ${stt.calls.length} times`);
    assert.deepEqual(first, second);
    assert.equal(u.text, 'hola');
  });

  test('a later question reuses the text rather than paying again', async () => {
    const u = utterance();
    const stt = provider('hola');
    const buffer = buffered(u);

    await transcribeBuffer(buffer, { provider: stt });
    await transcribeBuffer(buffer, { provider: stt });

    assert.equal(stt.calls.length, 1);
  });

  test('a failure is not cached as an in-flight promise forever', async () => {
    const u = utterance();
    let attempts = 0;
    const stt = {
      label: 'fake',
      async transcribe() {
        attempts += 1;
        throw new Error('temporary');
      },
    };

    const { failed } = await transcribeUtterance(u, stt);
    assert.equal(failed, true);
    // Marked consumed, so the next question doesn't retry it — but the
    // in-flight entry must be gone either way.
    assert.equal(u.text, '');
    await transcribeUtterance(u, stt);
    assert.equal(attempts, 1);
  });
});

describe('what the caller is told', () => {
  test('failures are counted and reported, since a person reads the number', async () => {
    const a = utterance();
    const b = utterance();
    const stt = provider((call) => (call === 1 ? new Error('bad chunk') : 'fine'));

    const result = await transcribeBuffer(buffered(a, b), { provider: stt });

    assert.equal(result.failed, 1);
    assert.equal(result.transcribed, 2);
  });

  test('a fatal error stops the sweep instead of firing the rest at a wall', async () => {
    // More utterances than CONCURRENCY, or there is nothing left to stop: the
    // whole batch starts before the first reply comes back.
    const fatal = Object.assign(new Error('no credit'), { fatal: true });
    const utterances = Array.from({ length: 30 }, () => utterance({ frames: 20 }));
    const stt = provider(fatal);

    await assert.rejects(
      () => transcribeBuffer(buffered(...utterances), { provider: stt }),
      /no credit/,
    );
    assert.ok(stt.calls.length < utterances.length, `tried all ${stt.calls.length}`);
    // Text stays null so the audio is still usable once the key is fixed.
    assert.equal(utterances.at(-1).text, null);
  });

  test('too short to be speech costs nothing', async () => {
    const u = utterance({ frames: 5 }); // 100ms
    const stt = provider('should not happen');
    const { spoken } = await transcribeUtterance(u, stt);

    assert.equal(spoken, false);
    assert.equal(stt.calls.length, 0);
    assert.equal(u.text, '');
  });
});
