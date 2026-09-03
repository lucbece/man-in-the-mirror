import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { VoiceSession, WAKE_TIMING, endsWithQuestion } from '../src/voice/session.js';
import { config } from '../src/config.js';

/**
 * "How does it know the question ended?" — it waits for the speaker to stop.
 * These exercise that state machine without a Discord connection.
 */

const GRACE = 30;
const OPEN = 90;
const SETTLE = 120;
const REPLY = 300;

before(() => {
  config.values.wakeEnabled = true;
  config.values.agentNames = 'mirror';
  WAKE_TIMING.graceMs = GRACE;
  WAKE_TIMING.openMs = OPEN;
  WAKE_TIMING.cooldownMs = 200;
  WAKE_TIMING.settleMs = SETTLE;
  WAKE_TIMING.replyMs = REPLY;
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
  s.awaitingReply = null;
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
    s.checkForWake(said('u1', 'Vero', 'mirror what do you think'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0].question, 'mirror what do you think');
  });

  test('waits when only the name arrives, then uses what follows', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror'));

    await wait(GRACE * 1.5);
    assert.equal(s.fired.length, 0, 'should still be listening, not answering');

    s.checkForWake(said('u1', 'Vero', 'what do you think about the servers'));
    await wait(GRACE * 3);
    assert.equal(s.fired[0].question, 'mirror what do you think about the servers');
  });

  test('stitches a question split by a mid-sentence pause', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror what do you think about'));
    await wait(GRACE * 0.6);
    s.checkForWake(said('u1', 'Vero', 'the servers being down'));
    await wait(GRACE * 3);
    assert.equal(
      s.fired[0].question,
      'mirror what do you think about the servers being down',
    );
  });

  test('ignores someone else talking over the asker', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror who is right'));
    s.checkForWake(said('u2', 'Marco', 'no way that is wrong'));
    await wait(GRACE * 3);
    assert.equal(s.fired[0].question, 'mirror who is right');
  });

  test('prompts back when nobody follows up', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror'));
    await wait(OPEN * 1.6);
    assert.equal(s.fired.length, 1);
    assert.match(s.fired[0].question, /ask what they want/i);
  });

  test('a rapid repeat produces one answer, not two', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror one thing'));
    await wait(GRACE * 3);
    s.checkForWake(said('u1', 'Vero', 'mirror another thing'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1, 'cooldown should suppress the second');
  });

  test('does nothing at all when its name is not mentioned', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'the servers were down all weekend'));
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

    s.checkForWake(said('u1', 'Vero', 'mirror how long would it take'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0, 'must not answer while someone is still talking');

    stops();
    await wait(GRACE);
    assert.equal(s.fired.length, 1, 'and answers as soon as they stop');
  });

  test('a quiet room costs nothing', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror what do you think'));

    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1, 'no waiting when nobody else is speaking');
  });

  test('does not wait for the asker to stop talking to themselves', async () => {
    // The asker's own speech is what the grace timer is already for. Waiting
    // on it again would double the pause before every single answer.
    const s = stubSession();
    talking(s, 'u1');

    s.checkForWake(said('u1', 'Vero', 'mirror what do you think'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 1);
  });

  test('gives up on someone who will not stop', async () => {
    // A stuck stream, or a genuinely long monologue. The question still gets
    // answered; it just answers without them.
    const s = stubSession();
    talking(s, 'u2');

    s.checkForWake(said('u1', 'Vero', 'mirror what do you think'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0);

    await wait(SETTLE);
    assert.equal(s.fired.length, 1, 'bounded, not indefinite');
  });
});

describe('answering the question the bot asked', () => {
  test('a reply needs no name when the bot ended by asking something', async () => {
    // "¿desde qué ciudad?" — making them say "espejo" again to answer that is
    // a bug in the conversation, not a policy.
    const s = stubSession();
    s.expectReply('u1', '¿Desde qué ciudad lo calculo?');

    s.checkForWake(said('u1', 'Vero', 'desde Córdoba'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0].question, 'desde Córdoba');
    assert.equal(s.fired[0].viaFollowUp, true, 'and it is marked, so the rate is measurable');
  });

  test('no window at all when the reply was not a question', async () => {
    // This is the guard that keeps it from becoming "answer everything after
    // you speak", which is the failure that gets a bot removed from a server.
    const s = stubSession();
    assert.equal(s.expectReply('u1', 'Son unas dieciocho horas de ruta.'), false);

    s.checkForWake(said('u1', 'Vero', 'qué largo che'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 0);
  });

  test('it belongs to the person who was asked, not to the room', async () => {
    // Two other people resuming their own conversation is not an answer.
    const s = stubSession();
    s.expectReply('u1', '¿Desde qué ciudad?');

    s.checkForWake(said('u2', 'Marco', 'che viste el partido'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0, 'somebody else is not the answer');

    s.checkForWake(said('u1', 'Vero', 'desde Córdoba'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1, 'and the window survived for the person it was for');
  });

  test('it is spent once, so it cannot catch a later sentence', async () => {
    const s = stubSession();
    s.expectReply('u1', '¿Desde qué ciudad?');

    s.checkForWake(said('u1', 'Vero', 'desde Córdoba'));
    await wait(GRACE * 3);

    s.checkForWake(said('u1', 'Vero', 'bueno me voy a comer'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 1, 'the second sentence was not for the bot');
  });

  test('it expires rather than waiting all call', async () => {
    const s = stubSession();
    s.expectReply('u1', '¿Desde qué ciudad?');

    await wait(REPLY + 50);
    s.checkForWake(said('u1', 'Vero', 'y bueno, mañana vemos'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 0);
  });

  test('saying its name still works while a window is open', async () => {
    const s = stubSession();
    s.expectReply('u1', '¿Desde qué ciudad?');

    s.checkForWake(said('u1', 'Vero', 'mirror olvidalo, otra cosa'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 1);
  });
});

describe('endsWithQuestion', () => {
  test('is what decides whether a window opens at all', () => {
    assert.equal(endsWithQuestion('¿Desde qué ciudad?'), true);
    assert.equal(endsWithQuestion('Which city?"'), true, 'a closing quote does not hide it');
    assert.equal(endsWithQuestion('Son dieciocho horas.'), false);
    assert.equal(endsWithQuestion('¿Sabés? Son dieciocho horas.'), false, 'only the end counts');
    assert.equal(endsWithQuestion(''), false);
    assert.equal(endsWithQuestion(null), false);
  });
});
