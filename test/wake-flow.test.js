import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { VoiceSession, WAKE_TIMING } from '../src/voice/session.js';
import { config } from '../src/config.js';

/**
 * "How does it know the question ended?" — it waits for the speaker to stop.
 * These exercise that state machine without a Discord connection.
 */

const GRACE = 30;
const OPEN = 90;
const SETTLE = 120;

before(() => {
  config.values.wakeEnabled = true;
  config.values.agentNames = 'mirror';
  WAKE_TIMING.graceMs = GRACE;
  WAKE_TIMING.openMs = OPEN;
  WAKE_TIMING.cooldownMs = 200;
  WAKE_TIMING.settleMs = SETTLE;
});

/** A session with only the wake machinery wired up. */
function stubSession() {
  const s = Object.create(VoiceSession.prototype);
  s.destroyed = false;
  s.lastWakeAt = 0;
  s.pendingWake = null;
  s.fired = [];
  s.emit = (event, payload) => {
    if (event === 'wake') s.fired.push(payload);
  };
  // Nobody else mid-sentence unless a test says so. `active` is the receiver's
  // map of who is being recorded right now — the one thing that is *not* in
  // the buffer yet.
  s.receiver = Object.assign(new EventEmitter(), { active: new Map() });
  return s;
}

/** Someone starts talking, and stops when the returned function is called. */
function talking(session, userId) {
  session.receiver.active.set(userId, { userId });
  return () => {
    session.receiver.active.delete(userId);
    session.receiver.emit('utterance', { userId });
  };
}

const said = (userId, displayName, text) => ({ userId, displayName, text });
const wait = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

describe('hearing out a question', () => {
  test('takes the question when it arrives in one breath', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror what do you think'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0].question, 'mirror what do you think');
  });

  test('waits when only the name arrives, then uses what follows', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror'));

    await wait(GRACE * 1.5);
    assert.equal(s.fired.length, 0, 'should still be listening, not answering');

    s.checkForWake(said('u1', 'Luc', 'what do you think about the servers'));
    await wait(GRACE * 3);
    assert.equal(s.fired[0].question, 'mirror what do you think about the servers');
  });

  test('stitches a question split by a mid-sentence pause', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror what do you think about'));
    await wait(GRACE * 0.6);
    s.checkForWake(said('u1', 'Luc', 'the servers being down'));
    await wait(GRACE * 3);
    assert.equal(
      s.fired[0].question,
      'mirror what do you think about the servers being down',
    );
  });

  test('ignores someone else talking over the asker', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror who is right'));
    s.checkForWake(said('u2', 'Marco', 'no way that is wrong'));
    await wait(GRACE * 3);
    assert.equal(s.fired[0].question, 'mirror who is right');
  });

  test('prompts back when nobody follows up', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror'));
    await wait(OPEN * 1.6);
    assert.equal(s.fired.length, 1);
    assert.match(s.fired[0].question, /ask what they want/i);
  });

  test('a rapid repeat produces one answer, not two', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror one thing'));
    await wait(GRACE * 3);
    s.checkForWake(said('u1', 'Luc', 'mirror another thing'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1, 'cooldown should suppress the second');
  });

  test('does nothing at all when its name is not mentioned', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'the servers were down all weekend'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0);
  });
});

describe('the rest of the room finishing the question', () => {
  test('waits for someone who is still talking, and takes what they said', async () => {
    // The gap this closes: an utterance only reaches the buffer once its
    // speaker has been quiet for SILENCE_MS, and the answer is built from the
    // buffer. Someone still mid-sentence when the grace timer fired was not
    // late to the answer — they were missing from it.
    const s = stubSession();
    const stops = talking(s, 'u2');

    s.checkForWake(said('u1', 'Luc', 'mirror how long would it take'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0, 'must not answer while someone is still talking');

    stops();
    await wait(GRACE);
    assert.equal(s.fired.length, 1, 'and answers as soon as they stop');
  });

  test('a quiet room costs nothing', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Luc', 'mirror what do you think'));

    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1, 'no waiting when nobody else is speaking');
  });

  test('does not wait for the asker to stop talking to themselves', async () => {
    // The asker's own speech is what the grace timer is already for. Waiting
    // on it again would double the pause before every single answer.
    const s = stubSession();
    talking(s, 'u1');

    s.checkForWake(said('u1', 'Luc', 'mirror what do you think'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 1);
  });

  test('gives up on someone who will not stop', async () => {
    // A stuck stream, or a genuinely long monologue. The question still gets
    // answered; it just answers without them.
    const s = stubSession();
    talking(s, 'u2');

    s.checkForWake(said('u1', 'Luc', 'mirror what do you think'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0);

    await wait(SETTLE);
    assert.equal(s.fired.length, 1, 'bounded, not indefinite');
  });
});
