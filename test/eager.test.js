import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { EagerTranscriber } from '../src/agent/eager.js';

/** An utterance carries only what the transcriber touches. */
const utterance = (id) => ({ id, packets: [1], durationMs: 2000, text: null });

describe('EagerTranscriber failure handling', () => {
  test('a fatal failure latches, and reset unlatches it', () => {
    // The bug this exists for: nothing called reset(), so one bad key or one
    // exhausted quota stopped transcription for the life of the process.
    // Switching provider in the panel appeared to do nothing, and from outside
    // the bot had just gone deaf.
    const eager = new EagerTranscriber({ label: ':test' });
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
    const eager = new EagerTranscriber({ label: ':test' });
    eager.stop();
    eager.reset();
    eager.push(utterance(1));
    assert.equal(eager.status().queued, 0, 'a stopped transcriber stays stopped');
  });
});
