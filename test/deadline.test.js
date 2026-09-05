import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  withDeadline,
  DeadlineError,
  takeTimeouts,
  sttDeadlineMs,
  wavSeconds,
} from '../src/agent/deadline.js';
import { pcmToWav } from '../src/agent/audio.js';

const hang = (signal) =>
  new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('withDeadline', () => {
  test('a request that answers in time passes its value through and counts nothing', async () => {
    takeTimeouts();
    const value = await withDeadline('stt', 50, async () => 'hola');
    assert.equal(value, 'hola');
    assert.equal(takeTimeouts(), undefined);
  });

  test('a miss is counted, tried once more, and the second attempt can succeed', async () => {
    takeTimeouts();
    let tries = 0;
    const value = await withDeadline('stt', 20, (signal) => {
      tries += 1;
      return tries === 1 ? hang(signal) : Promise.resolve('second time');
    });
    assert.equal(value, 'second time');
    assert.equal(tries, 2);
    assert.deepEqual(takeTimeouts(), { stt: 1 });
  });

  test('two misses throw a DeadlineError naming the stage, and count twice', async () => {
    takeTimeouts();
    await assert.rejects(
      withDeadline('tts', 20, (signal) => hang(signal)),
      (err) => err instanceof DeadlineError && err.stage === 'tts' && /tts gave no answer in 0\.0s/.test(err.message),
    );
    assert.deepEqual(takeTimeouts(), { tts: 2 });
  });

  test('once the first byte has arrived the rest may take as long as it likes', async () => {
    takeTimeouts();
    const value = await withDeadline('tts', 20, async (signal, arrived) => {
      arrived();
      await new Promise((r) => {
        setTimeout(r, 40);
      });
      assert.equal(signal.aborted, false);
      return 'slow body';
    });
    assert.equal(value, 'slow body');
    assert.equal(takeTimeouts(), undefined);
  });

  test('a failure of its own is not a timeout: no retry, no count', async () => {
    takeTimeouts();
    let tries = 0;
    await assert.rejects(
      withDeadline('stt', 50, async () => {
        tries += 1;
        throw new Error('401');
      }),
      /401/,
    );
    assert.equal(tries, 1);
    assert.equal(takeTimeouts(), undefined);
  });
});

describe('the STT deadline scales with the clip', () => {
  test('3 s plus a second per five seconds of audio, read from the WAV header', () => {
    const fourSeconds = pcmToWav(Buffer.alloc(16000 * 2 * 4));
    assert.ok(Math.abs(wavSeconds(fourSeconds) - 4) < 0.01);
    assert.equal(sttDeadlineMs(fourSeconds), 3800);
    assert.equal(sttDeadlineMs(Buffer.alloc(0)), 3000);
  });
});
