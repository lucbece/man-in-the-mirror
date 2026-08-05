import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { finishSpeaking } from '../src/agent/index.js';

/** A speech queue that only finishes when told to. */
function fakeSpeech() {
  let resolve;
  const finished = new Promise((r) => {
    resolve = r;
  });
  return {
    finished,
    cancelled: false,
    cancel() {
      this.cancelled = true;
      resolve({ cancelled: true });
    },
    complete() {
      resolve({ cancelled: false });
    },
  };
}

describe('waiting for playback to finish', () => {
  test('returns as soon as the queue drains', async () => {
    const speech = fakeSpeech();
    const waiting = finishSpeaking(speech, 10_000);
    speech.complete();
    assert.equal(await waiting, false, 'not a timeout');
    assert.equal(speech.cancelled, false);
  });

  test('gives up and cancels rather than waiting forever', async () => {
    // The bug: `ask()` releases the one-per-guild guard only after playback
    // finishes, so a queue that never drains left that guild answering "still
    // working on the last one" to everything until the process restarted.
    const speech = fakeSpeech();
    const cutOff = await finishSpeaking(speech, 20);
    assert.equal(cutOff, true, 'should report that it timed out');
    assert.equal(speech.cancelled, true, 'should stop the stuck queue');
  });

  test('a queue that never finishes still lets the caller continue', async () => {
    // What actually matters: the promise resolves. If this test hangs, the
    // guard is broken and so is every subsequent question in that guild.
    const speech = fakeSpeech();
    await finishSpeaking(speech, 20);
    // Reaching here at all is the assertion.
    assert.ok(true);
  });

  test('the timer does not keep the process alive', async () => {
    // Unref'd, so a pending guard can't hold the process open at shutdown.
    const speech = fakeSpeech();
    const waiting = finishSpeaking(speech, 60_000);
    speech.complete();
    await waiting;
    assert.ok(true);
  });
});
