import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { EagerTranscriber } from '../src/agent/eager.js';

/** An utterance carries only what the transcriber touches. */
const utterance = (id) => ({ id, packets: [1], durationMs: 2000, text: null });
/** A screen that says every clip is worth sending, with the loudness given. */
const loud = (activeRatio = 0.5) => (u) => ({ ms: u.durationMs, activeRatio, peakDb: -10, rmsDb: -20 });

describe('EagerTranscriber failure handling', () => {
  test('a fatal failure latches, and reset unlatches it', () => {
    // The bug this exists for: nothing called reset(), so one bad key or one
    // exhausted quota stopped transcription for the life of the process.
    // Switching provider in the panel appeared to do nothing, and from outside
    // the bot had just gone deaf.
    const eager = new EagerTranscriber({ label: ':test', screen: loud() });
    eager.fail(Object.assign(new Error('insufficient_quota'), { fatal: true }));

    assert.equal(eager.status().error, 'insufficient_quota');
    eager.push(utterance(1));
    assert.equal(eager.status().queued, 0, 'a latched transcriber must drop work');

    eager.reset();
    assert.equal(eager.status().error, null);
    eager.stop(); // don't let it actually try to transcribe
  });

  test('reset also clears the counted non-fatal failures', () => {
    const eager = new EagerTranscriber({ label: ':test' });
    eager.failures = 7;
    eager.reset();
    assert.equal(eager.status().failures, 0);
    eager.stop();
  });

  test('status reports failures, so a silent bot can be diagnosed', () => {
    const eager = new EagerTranscriber({ label: ':test' });
    const status = eager.status();
    assert.equal(status.failures, 0);
    assert.ok('queued' in status && 'running' in status && 'completed' in status);
    eager.stop();
  });

  test('stopping is not the same as failing, and reset does not undo it', () => {
    const eager = new EagerTranscriber({ label: ':test', screen: loud() });
    eager.stop();
    eager.reset();
    eager.push(utterance(1));
    assert.equal(eager.status().queued, 0, 'a stopped transcriber stays stopped');
  });
});

describe('the queue', () => {
  /** A transcriber whose workers never finish, so the queue can be inspected. */
  function stuck(concurrency = 1) {
    const eager = new EagerTranscriber({ label: ':test', concurrency, screen: loud() });
    eager.transcribe = () => new Promise(() => {});
    return eager;
  }

  test('a clip that sounds like a sentence goes before the noises already waiting', () => {
    const eager = stuck(1);
    eager.push({ ...utterance('busy'), durationMs: 3000 }); // takes the one worker
    eager.push({ ...utterance('short'), durationMs: 400 });
    eager.push({ ...utterance('short2'), durationMs: 500 });
    eager.push({ ...utterance('sentence'), durationMs: 2500 });
    assert.deepEqual(eager.queue.map((q) => q.utterance.id), ['sentence', 'short2', 'short']);
    eager.stop();
  });

  test('a clip the screen refuses never enters the queue', () => {
    const eager = new EagerTranscriber({ label: ':test', concurrency: 0, screen: () => null });
    eager.push(utterance(1));
    assert.equal(eager.status().queued, 0);
    eager.stop();
  });

  test('concurrency can be raised while the queue is live', () => {
    const eager = stuck(1);
    eager.push(utterance(1));
    eager.push(utterance(2));
    assert.equal(eager.status().running, 1);
    eager.concurrency = 2;
    eager.drain();
    assert.equal(eager.status().running, 2);
    eager.stop();
  });
});
