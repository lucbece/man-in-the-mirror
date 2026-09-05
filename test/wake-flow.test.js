import assert from 'node:assert/strict';
import test, { before, describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { VoiceSession, WAKE_TIMING, endsWithQuestion, looksLikeFollowUp } from '../src/voice/session.js';
import { config } from '../src/config.js';

/**
 * "How does it know the question ended?" — it waits for the speaker to stop.
 * These exercise that state machine without a Discord connection.
 */

const GRACE = 30;
const OPEN = 90;
const SETTLE = 120;
const REPLY = 300;
const FOLLOW_UP = 150;

before(() => {
  config.values.wakeEnabled = true;
  config.values.agentNames = 'mirror';
  WAKE_TIMING.graceMs = GRACE;
  WAKE_TIMING.openMs = OPEN;
  WAKE_TIMING.cooldownMs = 200;
  WAKE_TIMING.settleMs = SETTLE;
  WAKE_TIMING.replyMs = REPLY;
  WAKE_TIMING.followUpMs = FOLLOW_UP;
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
  s.speech = null;
  s.shushed = 0;
  s.shush = () => {
    s.shushed += 1;
  };
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

describe('the grace counts from the end of the audio', () => {
  test('a transcript that arrives after the grace has passed is asked about at once', async () => {
    const s = stubSession();
    // The clip ended long ago; transcription took longer than the grace.
    s.checkForWake({ ...said('u1', 'Vero', 'mirror what do you think'), endedAt: Date.now() - GRACE * 4 });
    await wait(5);
    assert.equal(s.fired.length, 1, 'no second wait after the one the transcription already cost');
  });

  test('unless the speaker is still talking, in which case their next words are waited for', async () => {
    const s = stubSession();
    const stop = talking(s, 'u1');
    s.checkForWake({ ...said('u1', 'Vero', 'mirror what do you'), endedAt: Date.now() - GRACE * 4 });
    await wait(5);
    assert.equal(s.fired.length, 0, 'their sentence is not over');
    s.checkForWake(said('u1', 'Vero', 'think about it'));
    stop();
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0].question, 'mirror what do you think about it');
  });

  test('or a later clip of theirs is still being transcribed', async () => {
    const s = stubSession();
    const later = { userId: 'u1', endedAt: Date.now(), text: null };
    s.receiver.buffer = { untranscribed: () => [later] };
    s.checkForWake({ ...said('u1', 'Vero', 'mirror what do you'), endedAt: Date.now() - GRACE * 4 });
    await wait(5);
    assert.equal(s.fired.length, 0);
    later.text = 'think about it';
    s.receiver.buffer = { untranscribed: () => [] };
    s.checkForWake({ ...said('u1', 'Vero', 'think about it'), endedAt: later.endedAt });
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0].question, 'mirror what do you think about it');
  });
});

describe('following up without the name', () => {
  test('the person who asked can follow up for a few seconds, with something shaped like one', async () => {
    const s = stubSession();
    assert.equal(s.expectReply('u1', 'Son unas dieciocho horas de ruta.'), false, 'not a question, so no log-worthy window');

    s.checkForWake(said('u1', 'Vero', 'y en avión cuánto es'));
    await wait(GRACE * 3);

    assert.equal(s.fired.length, 1);
    assert.equal(s.fired[0].question, 'y en avión cuánto es');
    assert.equal(s.fired[0].viaFollowUp, true);
  });

  test('a remark to the room in that window is not a follow-up, and does not close it', async () => {
    const s = stubSession();
    s.expectReply('u1', 'Son unas dieciocho horas de ruta.');

    s.checkForWake(said('u1', 'Vero', 'qué largo che'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0);

    s.checkForWake(said('u1', 'Vero', 'pero en auto, no?'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 1, 'the window was still there for the real follow-up');
  });

  test('somebody else cannot use it, and it expires sooner than the reply window', async () => {
    const s = stubSession();
    s.expectReply('u1', 'Son unas dieciocho horas de ruta.');

    s.checkForWake(said('u2', 'Marco', 'y por qué tanto?'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0);

    await wait(FOLLOW_UP);
    s.checkForWake(said('u1', 'Vero', 'y por qué tanto?'));
    await wait(GRACE * 3);
    assert.equal(s.fired.length, 0, 'expired');
  });

  test('looksLikeFollowUp: openers and question marks, nothing else', () => {
    for (const yes of ['y por qué', 'pero cuándo fue', 'entonces conviene el sábado', 'cuánto sale?', 'Why though', 'en serio?']) {
      assert.equal(looksLikeFollowUp(yes), true, yes);
    }
    for (const no of ['qué largo che', 'bueno me voy a comer', 'jaja', 'dale', '']) {
      assert.equal(looksLikeFollowUp(no), false, no);
    }
  });
});

describe('cutting it off', () => {
  test('"espejo, basta" while it talks stops it on the spot, with no wake', async () => {
    const s = stubSession();
    s.speech = {};
    s.checkForWake(said('u1', 'Vero', 'mirror, basta'));
    await wait(GRACE * 3);
    assert.equal(s.shushed, 1);
    assert.equal(s.fired.length, 0);
  });

  test('"mirror" in one breath and "basta" in the next, while it talks, is a hush too', async () => {
    const s = stubSession();
    s.speech = {};
    s.checkForWake(said('u1', 'Vero', 'mirror'));
    s.checkForWake(said('u1', 'Vero', 'basta'));
    await wait(OPEN + GRACE);
    assert.equal(s.shushed, 1);
    assert.equal(s.fired.length, 0, 'no question was asked out of "mirror basta"');
  });

  test('the same words when it is silent are a question like any other', async () => {
    const s = stubSession();
    s.checkForWake(said('u1', 'Vero', 'mirror, basta'));
    await wait(GRACE * 3);
    assert.equal(s.shushed, 0);
    assert.equal(s.fired.length, 1);
  });

  test('"mirror, basta de hablar de fútbol" is a request, not a hush', async () => {
    const s = stubSession();
    s.speech = {};
    s.checkForWake(said('u1', 'Vero', 'mirror, basta de hablar de fútbol'));
    await wait(GRACE * 3);
    assert.equal(s.shushed, 0);
    assert.equal(s.fired.length, 1);
  });
});
