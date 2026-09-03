import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { VoiceSession } from '../src/voice/session.js';
import { quietTools } from '../src/agent/tools/quiet.js';
import { botToolsServer } from '../src/agent/tools/index.js';
import { sessionManager } from '../src/voice/manager.js';

/**
 * The switch itself: the flag on the session, and the two tools that flip it.
 *
 * A real VoiceSession is used rather than a fake, because what is being
 * checked here is precisely the part a fake would paper over — that the track
 * is not paused to make room for a voice that will never speak. The connection
 * never leaves Signalling with an adapter that answers nobody, which is all
 * these need.
 */
function session(t, { guildId = 'g1' } = {}) {
  const channel = {
    id: 'c1',
    name: 'general',
    client: { channels: { cache: new Map() } },
    guild: {
      id: guildId,
      name: 'Casa',
      voiceAdapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }),
    },
  };
  const s = new VoiceSession(channel);
  t.after(() => s.destroy());
  return s;
}

/** Find a tool by the name the model calls it by, and run it. */
function run(tools, name, args = {}) {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `no tool named ${name}`);
  return found.handler(args, {});
}

const said = (result) => result.content.map((c) => c.text).join(' ');

describe('the flag on the session', () => {
  test('starts off, and shows in the status the panel renders', (t) => {
    const s = session(t);
    assert.equal(s.status().quiet, false);
    s.setQuiet(true);
    assert.equal(s.status().quiet, true);
  });

  test('reports where it landed, and ignores being set twice', (t) => {
    const s = session(t);
    assert.equal(s.setQuiet(true), true);
    let updates = 0;
    s.on('update', () => { updates += 1; });
    assert.equal(s.setQuiet(true), true);
    assert.equal(updates, 0, 'nothing changed, so the panel has nothing to redraw');
    assert.equal(s.setQuiet(false), false);
    assert.equal(updates, 1);
  });

  test('a speech begun while quiet does not pause the music', (t) => {
    // The whole point. Pausing the track to make room for a voice that is
    // then dropped is the failure this mode exists to prevent, and it happens
    // before the speech queue ever sees a sentence.
    const s = session(t);
    let paused = 0;
    s.music.pauseForSpeech = () => {
      paused += 1;
      return true;
    };

    s.setQuiet(true);
    const speech = s.startSpeech();
    assert.equal(paused, 0);

    speech.push({ id: 'una' }, 'Una frase.');
    assert.deepEqual(speech.spoken, [], 'and nothing is spoken through it either');
  });

  test('but a speech begun while talking still does', (t) => {
    const s = session(t);
    let paused = 0;
    s.music.pauseForSpeech = () => {
      paused += 1;
      return true;
    };

    s.startSpeech();
    assert.equal(paused, 1);
  });

  test('turning it on stops the sentence in flight', async (t) => {
    // Somebody asking for quiet over a song wants the sentence they are
    // hearing to stop, not the one after it.
    const s = session(t);
    const speech = s.startSpeech();
    s.setQuiet(true);
    assert.equal((await speech.finished).cancelled, true);
  });
});

describe('switching by voice', () => {
  const turn = (guildId) => ({ guildId, askerId: 'asker', askerName: 'Vero', guild: () => null });

  function joined(t, guildId) {
    const s = session(t, { guildId });
    sessionManager.sessions.set(guildId, s);
    t.after(() => sessionManager.sessions.delete(guildId));
    return s;
  }

  test('both tools are registered on the bot server', (t) => {
    const s = joined(t, 'registered');
    assert.ok(s);
    const names = new Set(quietTools(turn('registered')).map((tool) => tool.name));
    assert.deepEqual([...names].sort(), ['enter_music_mode', 'leave_music_mode']);
    assert.equal(botToolsServer('registered', turn('registered')).name, 'bot');
  });

  test('the descriptions carry the words people actually say', () => {
    const [enter, leave] = quietTools(turn('g1'));
    // Spoken requests, in both languages the room uses. A description written
    // as a tidy paraphrase is a tool the model never reaches for when someone
    // says "mutéate" over a song.
    for (const phrase of ['mutéate', 'modo música', 'callate hasta que te avise', 'no hables mientras suena', 'mute yourself']) {
      assert.ok(enter.description.includes(phrase), `enter_music_mode never names "${phrase}"`);
    }
    for (const phrase of ['hablá de nuevo', 'salí del modo música', 'desmuteate', 'you can talk again']) {
      assert.ok(leave.description.includes(phrase), `leave_music_mode never names "${phrase}"`);
    }
  });

  test('entering turns it on and asks for a line that will be written', async (t) => {
    const s = joined(t, 'entering');
    const result = await run(quietTools(turn('entering')), 'enter_music_mode');

    assert.equal(s.quiet, true);
    assert.match(said(result), /goes into the music channel/);
  });

  test('leaving turns it off and asks for a line said out loud', async (t) => {
    const s = joined(t, 'leaving');
    s.setQuiet(true);
    const result = await run(quietTools(turn('leaving')), 'leave_music_mode');

    assert.equal(s.quiet, false);
    assert.match(said(result), /Say a short line out loud confirming it/);
  });

  test('asked for something it is already doing, it says so rather than flapping', async (t) => {
    const s = joined(t, 'already');
    s.setQuiet(true);
    assert.match(said(await run(quietTools(turn('already')), 'enter_music_mode')), /already/i);
    assert.equal(s.quiet, true);

    s.setQuiet(false);
    assert.match(said(await run(quietTools(turn('already')), 'leave_music_mode')), /not in music mode/i);
  });

  test('with the bot in no channel, it refuses in words rather than crashing', async () => {
    for (const name of ['enter_music_mode', 'leave_music_mode']) {
      const result = await run(quietTools(turn('nowhere')), name);
      assert.match(said(result), /not in a voice channel/i, name);
    }
  });
});

describe('shushing over a song', () => {
  test('gives the track back instead of leaving it paused', async (t) => {
    // The handover lives in the speech queue's `finished` handler. A shush
    // that cleared the queue before cancelling it made that handler bail,
    // and the song it had paused stayed paused until the next answer ended.
    const s = session(t);
    let resumed = 0;
    s.music.pauseForSpeech = () => true;
    s.music.resumeAfterSpeech = () => {
      resumed += 1;
    };
    s.startSpeech();
    s.shush();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    assert.equal(resumed, 1);
    assert.equal(s.speech, null, 'and the queue is gone once it has drained');
  });
});
