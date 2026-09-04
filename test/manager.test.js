import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { SessionManager, describeChanges } from '../src/voice/manager.js';
import { config } from '../src/config.js';
import { reminders } from '../src/agent/reminders.js';

/**
 * The registry, without a gateway.
 *
 * This is the file where the bugs were: a session torn down mid-call, an agent
 * killed for the channel it had just been prepared for, a config switch that
 * only reached the *next* join. None of that is about Discord — it is about
 * which session is in the map — but a real VoiceSession opens a voice
 * connection in its constructor, so it was untestable by accident.
 */

/** A session with the surface the manager touches, and nothing else. */
function fakeSession(channel) {
  const session = new EventEmitter();
  Object.assign(session, {
    guildId: channel.guild.id,
    channelId: channel.id,
    channelName: channel.name,
    destroyed: false,
    speaking: false,
    windowSet: null,
    eagerReset: 0,
    listening: null,
    receiver: { setWindow: (s) => { session.windowSet = s; } },
    eager: { reset: () => { session.eagerReset += 1; } },
    setAgentEnabled(value) {
      session.listening = value;
      return Promise.resolve();
    },
    destroy() {
      session.destroyed = true;
      session.emit('destroyed');
    },
    waitUntilReady: () => channel.readyFails
      ? Promise.reject(new Error('connection timed out'))
      : Promise.resolve(),
    status: () => ({ guildId: session.guildId, channelId: session.channelId }),
  });
  return session;
}

const channel = (id, { guildId = 'g1', readyFails = false } = {}) => ({
  id,
  name: id,
  readyFails,
  guild: { id: guildId },
});

/** A manager whose sessions are fakes, disposed at the end of the test. */
function manager(t, { createSession = fakeSession } = {}) {
  // warmAgent stubbed: the real one starts an Agent SDK subprocess holding
  // about a gigabyte, which a test for a registry has no business doing.
  const m = new SessionManager({ createSession, warmAgent: () => {} });
  t.after(() => m.dispose());
  return m;
}

describe('one session per guild', () => {
  test('joining registers it, and joining the same channel reuses it', async (t) => {
    const m = manager(t);
    const first = await m.join(channel('general'));

    assert.equal(m.get('g1'), first);
    assert.equal(await m.join(channel('general')), first, 'must not rebuild for the same channel');
    assert.equal(first.destroyed, false);
  });

  test('moving to another channel replaces the session', async (t) => {
    const m = manager(t);
    const first = await m.join(channel('general'));
    const second = await m.join(channel('terraza'));

    assert.notEqual(second, first);
    assert.equal(first.destroyed, true, 'the old one has to go');
    assert.equal(m.get('g1'), second);
    assert.equal(m.list().length, 1, 'one guild, one session');
  });

  test('guilds do not interfere with each other', async (t) => {
    const m = manager(t);
    const a = await m.join(channel('general', { guildId: 'g1' }));
    const b = await m.join(channel('general', { guildId: 'g2' }));

    m.leave('g1');
    assert.equal(m.get('g1'), null);
    assert.equal(m.get('g2'), b);
    assert.equal(a.destroyed, true);
    assert.equal(b.destroyed, false);
  });
});

describe('the identity guard on teardown', () => {
  test('a late "destroyed" from the old session does not evict the new one', async (t) => {
    // The bug this exists for, in order: moving between channels destroys A,
    // builds B, pre-warms B's agent — and only then does A's 'destroyed'
    // arrive from the voice connection's state handler. Handled without the
    // identity check, it killed the session that had just been prepared for B.
    const m = manager(t);
    const first = await m.join(channel('general'));
    first.destroyed = true; // destroyed, but its event has not landed yet
    const second = await m.join(channel('terraza'));

    first.emit('destroyed'); // arrives late

    assert.equal(m.get('g1'), second, 'the new session must survive');
    assert.equal(m.list().length, 1);
  });

  test('the session actually in the map does evict itself when it dies', async (t) => {
    // The other half: a connection dropped by Discord has to clear the map,
    // or the bot looks connected to a channel it left.
    const m = manager(t);
    const session = await m.join(channel('general'));

    session.emit('destroyed');

    assert.equal(m.get('g1'), null);
    assert.equal(m.list().length, 0);
  });
});

describe('a join that never connects', () => {
  test('leaves nothing behind, and says which channel', async (t) => {
    const m = manager(t);

    await assert.rejects(
      () => m.join(channel('roto', { readyFails: true })),
      /Could not connect to roto/,
    );
    assert.equal(m.get('g1'), null, 'a half-joined session must not linger');
  });

  test('keeps the original failure as the cause', async (t) => {
    const m = manager(t);
    const err = await m.join(channel('roto', { readyFails: true })).catch((e) => e);

    assert.equal(err.cause?.message, 'connection timed out');
  });
});

describe('settings reaching a session already in a channel', () => {
  test('listening switches on a live session, not just the next one', async (t) => {
    // Otherwise the panel switch sets a value for the *next* join and appears
    // to do nothing, which teaches people not to trust the panel.
    const m = manager(t);
    const session = await m.join(channel('general'));
    const before = config.get('agentEnabled');
    t.after(() => config.update({ agentEnabled: before }));

    config.update({ agentEnabled: !before });

    assert.equal(session.listening, !before);
  });

  test('the audio window reaches live sessions', async (t) => {
    const m = manager(t);
    const session = await m.join(channel('general'));
    const before = config.get('bufferSeconds');
    t.after(() => config.update({ bufferSeconds: before }));

    config.update({ bufferSeconds: before === 120 ? 90 : 120 });

    assert.equal(session.windowSet, before === 120 ? 90 : 120);
  });

  test('changing where it hears clears the failure that stopped it', async (t) => {
    // A provider change is exactly the fix someone reaches for after
    // transcription failed, so it has to clear the latch that failure set.
    const m = manager(t);
    const session = await m.join(channel('general'));
    const before = config.get('sttProvider');
    t.after(() => config.update({ sttProvider: before }));

    config.update({ sttProvider: before === 'local' ? 'openai' : 'local' });

    assert.equal(session.eagerReset, 1);
  });

  test('an unrelated change does not reset anything', async (t) => {
    const m = manager(t);
    const session = await m.join(channel('general'));
    const before = config.get('agentNames');
    t.after(() => config.update({ agentNames: before }));

    config.update({ agentNames: 'espejo, mirror, manuel' });

    assert.equal(session.eagerReset, 0);
  });
});

describe('a reminder with nowhere to go', () => {
  test('is dropped rather than thrown', async (t) => {
    // Nothing awaits this handler, so anything it throws is an unhandled
    // rejection in a process that is otherwise fine.
    const m = manager(t);
    t.after(() => reminders.clearGuild('nobody-here'));

    reminders.emit('fire', { guildId: 'nobody-here', id: 1, message: 'hola' });
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(m.get('nobody-here'), null);
  });
});

describe('a reminder that comes due in music mode', () => {
  /**
   * A guild whose music channel accepts a message, so what the reminder does
   * with it is visible. The bot never speaks on this path, which is the point:
   * an alarm over the song is exactly what the mode was turned on to stop.
   */
  function guildWithMusicChannel(sent) {
    const channel = {
      name: 'music',
      isTextBased: () => true,
      isVoiceBased: () => false,
      permissionsFor: () => ({ has: () => true }),
      send: (text) => {
        sent.push(text);
        return Promise.resolve();
      },
    };
    return {
      channels: { cache: new Map([['music', channel]]) },
      members: { me: {} },
    };
  }

  async function fire(t, { guild, spoke }) {
    const m = manager(t);
    const session = await m.join(channel('general'));
    session.quiet = true;
    session.client = { guilds: { cache: new Map([['g1', guild]]) } };
    // Speaking would go through the player; a fake session has none, so
    // reaching for one at all is what "it spoke" looks like here.
    Object.defineProperty(session, 'player', {
      get() {
        spoke.push('spoke');
        return { stop: () => {}, play: () => {} };
      },
    });

    reminders.emit('fire', { guildId: 'g1', id: 7, message: 'sacá la pizza del horno' });
    await new Promise((resolve) => { setImmediate(resolve); });
    await new Promise((resolve) => { setImmediate(resolve); });
    return session;
  }

  test('is written in the music channel, not spoken', async (t) => {
    const sent = [];
    const spoke = [];
    await fire(t, { guild: guildWithMusicChannel(sent), spoke });

    assert.deepEqual(sent, ['⏰  sacá la pizza del horno']);
    assert.deepEqual(spoke, [], 'an alarm over the song serves nobody');
  });

  test('with no music channel it is dropped, never said late', async (t) => {
    // Same rule as one that came due while the process was down: a promise
    // kept half an hour after the fact is worse than one quietly missed.
    const spoke = [];
    await fire(t, { guild: { channels: { cache: new Map() }, members: { me: {} } }, spoke });

    assert.deepEqual(spoke, []);
  });
});

describe('leaving', () => {
  test('reports whether there was anything to leave', async (t) => {
    const m = manager(t);
    assert.equal(m.leave('g1'), false, 'nothing joined yet');

    await m.join(channel('general'));
    assert.equal(m.leave('g1'), true);
    assert.equal(m.leave('g1'), false, 'and only once');
  });

  test('leaveAll empties every guild', async (t) => {
    const m = manager(t);
    await m.join(channel('general', { guildId: 'g1' }));
    await m.join(channel('general', { guildId: 'g2' }));

    m.leaveAll();

    assert.deepEqual(m.list(), []);
    assert.deepEqual(m.status(), []);
  });
});

describe('who the voice connection is carrying', () => {
  /**
   * The one thing that cannot be inferred from the player objects: a track can
   * be "playing" and reach nobody, because the connection is still subscribed
   * to the speaking voice. That is what happened the first time music was made
   * silent — the handover only ran when a *speech* ended, so a command that
   * said nothing never handed the connection over.
   */
  function sessionWithPlayers() {
    const subscribed = [];
    const speechPlayer = { id: 'speech' };
    const musicPlayer = { id: 'music' };
    const session = {
      destroyed: false,
      speech: null,
      player: speechPlayer,
      music: { player: musicPlayer, playing: false },
      connection: {
        subscribe: (p) => {
          subscribed.push(p.id);
          return { player: p };
        },
      },
      handMouthTo(owner) {
        if (session.destroyed) return;
        session.connection.subscribe(owner === 'music' ? session.music.player : session.player);
      },
    };
    return { session, subscribed };
  }

  test('music takes the connection when nothing is being said', () => {
    const { session, subscribed } = sessionWithPlayers();
    session.music.playing = true;

    if (session.music.playing && !session.speech) session.handMouthTo('music');

    assert.deepEqual(subscribed, ['music'], 'a silent command must still be audible');
  });

  test('but not while the bot is mid-sentence', () => {
    const { session, subscribed } = sessionWithPlayers();
    session.music.playing = true;
    session.speech = { pending: true };

    if (session.music.playing && !session.speech) session.handMouthTo('music');

    assert.deepEqual(subscribed, [], 'stealing it mid-answer would cut the answer off');
  });
});

describe('the [config] line for the thinking mode', () => {
  const base = {
    brainKind: 'chat',
    brainProvider: 'anthropic',
    brainModel: '',
    fastModel: '',
    webSearch: false,
    mcpServers: '',
    sttProvider: 'openai',
    sttLocalModel: '',
    ttsProvider: 'openai',
    ttsVoice: '',
    ttsLocalVoice: '',
    agentNames: 'mirror',
  };

  function logged(values, previous) {
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      describeChanges({ ...base, ...values }, { ...base, ...previous });
    } finally {
      console.log = original;
    }
    return lines.filter((l) => l.includes('thinking →'));
  }

  test('cascade names the fast model and the agent behind it', () => {
    const lines = logged({ brainKind: 'cascade', fastModel: 'claude-sonnet-5' }, {});
    assert.deepEqual(lines, ['[config] thinking → claude-sonnet-5 in front of Claude agent claude-sonnet-5']);
  });

  test('cascade with a blank fast model names the default', () => {
    const lines = logged({ brainKind: 'cascade' }, {});
    assert.deepEqual(lines, ['[config] thinking → claude-haiku-4-5 in front of Claude agent claude-sonnet-5']);
  });

  test('changing only the fast model is announced', () => {
    const lines = logged(
      { brainKind: 'cascade', fastModel: 'claude-sonnet-5' },
      { brainKind: 'cascade', fastModel: '' },
    );
    assert.equal(lines.length, 1);
  });

  test('agent and chat keep their lines', () => {
    assert.deepEqual(logged({ brainKind: 'agent' }, {}), [
      '[config] thinking → Claude agent claude-sonnet-5 (no MCP servers)',
    ]);
    assert.deepEqual(logged({ brainKind: 'chat', brainProvider: 'openai' }, { brainProvider: 'anthropic' }), [
      '[config] thinking → openai gpt-4.1',
    ]);
  });
});
