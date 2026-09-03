import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { SpeechQueue } from '../src/voice/speech-queue.js';

/** Stands in for Discord's player: records what it played, idles on demand. */
class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.played = [];
  }

  play(resource) {
    this.played.push(resource);
  }

  /** Whatever is playing has run out. */
  finishCurrent() {
    this.emit('idle');
  }
}

// The queue listens for AudioPlayerStatus.Idle, whose value is the string
// 'idle' — asserted here so a library rename fails loudly rather than
// silently leaving every piece after the first unplayed.
test('the idle status this depends on is still "idle"', async () => {
  const { AudioPlayerStatus } = await import('@discordjs/voice');
  assert.equal(AudioPlayerStatus.Idle, 'idle');
});

describe('SpeechQueue', () => {
  test('plays the first piece immediately and the rest in order', () => {
    const player = new FakePlayer();
    const queue = new SpeechQueue(player);

    queue.push('one', 'uno');
    assert.deepEqual(player.played, ['one'], 'the first should not wait');

    queue.push('two', 'dos');
    assert.deepEqual(player.played, ['one'], 'the second waits its turn');

    player.finishCurrent();
    assert.deepEqual(player.played, ['one', 'two']);
  });

  test('waits for a piece that has not been synthesised yet', async () => {
    // The gap this guards: the model is still generating, so the queue drains
    // before the answer is over. Finishing there would cut the reply in half.
    const player = new FakePlayer();
    const queue = new SpeechQueue(player);
    let done = false;
    queue.finished.then(() => { done = true; });

    queue.push('one', 'uno');
    player.finishCurrent();
    await Promise.resolve();
    assert.equal(done, false, 'must not finish while more may be coming');

    queue.push('two', 'dos');
    assert.deepEqual(player.played, ['one', 'two']);

    queue.end();
    player.finishCurrent();
    const result = await queue.finished;
    assert.equal(result.cancelled, false);
    assert.deepEqual(result.spoken, ['uno', 'dos']);
  });

  test('end() with an empty queue finishes right away', async () => {
    const player = new FakePlayer();
    const queue = new SpeechQueue(player);
    queue.end();
    assert.equal((await queue.finished).cancelled, false);
  });

  test('cancel abandons what is queued and says so', async () => {
    const player = new FakePlayer();
    const queue = new SpeechQueue(player);
    queue.push('one', 'uno');
    queue.push('two', 'dos');

    queue.cancel();
    player.finishCurrent();
    assert.deepEqual(player.played, ['one'], 'the queued piece must not start');

    const result = await queue.finished;
    assert.equal(result.cancelled, true);
  });

  test('pushing after cancel does nothing', () => {
    // A brain that keeps streaming after "stop talking" must not restart it.
    const player = new FakePlayer();
    const queue = new SpeechQueue(player);
    queue.cancel();
    queue.push('late', 'tarde');
    assert.deepEqual(player.played, []);
  });

  test('a piece that fails to play does not wedge the rest', () => {
    const player = new FakePlayer();
    player.play = function (resource) {
      if (resource === 'bad') throw new Error('nope');
      this.played.push(resource);
    };
    const queue = new SpeechQueue(player);
    queue.push('bad', 'malo');
    queue.push('good', 'bueno');
    assert.deepEqual(player.played, ['good']);
  });

  test('a muted queue plays nothing at all', () => {
    // Music mode. The queue is the last door before the audio, so a filler
    // clip, a line before a tool and the answer itself all have to hit this
    // one check — there is no second place to add.
    const player = new FakePlayer();
    const queue = new SpeechQueue(player, () => true);

    queue.push('one', 'uno');
    queue.push('two', 'dos');

    assert.deepEqual(player.played, [], 'nothing may reach the player');
    assert.deepEqual(queue.spoken, [], 'and nothing may be reported as said');
  });

  test('unmuting mid-answer lets the next sentence through', async () => {
    // How "espejo, hablá de nuevo" gets an answer out loud: the tool flips the
    // flag, and the sentence rendered after it is spoken by the same turn.
    const player = new FakePlayer();
    let muted = true;
    const queue = new SpeechQueue(player, () => muted);

    queue.push('callado', 'Nada.');
    assert.deepEqual(player.played, []);

    muted = false;
    queue.push('vuelta', 'Listo, vuelvo a hablar.');
    queue.end();
    player.finishCurrent();

    assert.deepEqual(player.played, ['vuelta']);
    assert.deepEqual((await queue.finished).spoken, ['Listo, vuelvo a hablar.']);
  });

  test('stops listening to the player once finished', async () => {
    // Every answer builds a queue; leaking a listener each time would hit
    // Node's max-listeners warning after a dozen questions.
    const player = new FakePlayer();
    const queue = new SpeechQueue(player);
    queue.push('one', 'uno');
    queue.end();
    player.finishCurrent();
    await queue.finished;
    assert.equal(player.listenerCount('idle'), 0);
  });
});
