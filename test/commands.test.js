import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';

import { handleInteraction } from '../src/bot/commands.js';
import { sessionManager } from '../src/voice/manager.js';

/**
 * The slash commands, with a fake interaction.
 *
 * Most handlers are one call each into things already tested, so what is
 * checked here is the part that is only in this file: which subcommand runs,
 * what happens to a handler that throws halfway, and the guards that stop
 * `/mj join` before it reaches Discord at all.
 */
function fakeInteraction({
  sub = 'status',
  guildId = 'g1',
  channel = null,
  memberChannel = null,
  commandName = 'mj',
  chatInput = true,
  query = null,
} = {}) {
  const calls = [];
  return {
    calls,
    guildId,
    commandName,
    deferred: false,
    replied: false,
    isChatInputCommand: () => chatInput,
    options: {
      getSubcommand: () => sub,
      getChannel: () => channel,
      getString: (name) => (name === 'query' ? query : null),
    },
    member: { voice: { channel: memberChannel } },
    guild: { members: { me: { id: 'bot' } } },
    client: { guilds: { cache: new Map() } },
    reply(payload) {
      this.replied = true;
      calls.push(['reply', payload]);
      return Promise.resolve();
    },
    deferReply() {
      this.deferred = true;
      calls.push(['deferReply']);
      return Promise.resolve();
    },
    editReply(payload) {
      calls.push(['editReply', payload]);
      return Promise.resolve();
    },
    followUp(payload) {
      calls.push(['followUp', payload]);
      return Promise.resolve();
    },
  };
}

/** Everything the handler said, as one searchable string. */
const said = (interaction) =>
  interaction.calls
    .map(([, payload]) => (typeof payload === 'string' ? payload : payload?.content ?? ''))
    .join('\n');

const voiceChannel = ({ permissions = [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak], throws = false } = {}) => ({
  id: 'vc',
  name: 'general',
  toString: () => '#general',
  permissionsFor: () => {
    if (throws) throw new Error('Discord said no');
    return { has: (flag) => permissions.includes(flag) };
  },
});

describe('routing', () => {
  test('ignores anything that is not our slash command', async () => {
    for (const other of [
      fakeInteraction({ chatInput: false }),
      fakeInteraction({ commandName: 'something-else' }),
    ]) {
      await handleInteraction(other);
      assert.deepEqual(other.calls, [], 'must not answer someone else\'s command');
    }
  });

  test('an unknown subcommand says so rather than failing silently', async () => {
    const i = fakeInteraction({ sub: 'nonsense' });
    await handleInteraction(i);
    assert.match(said(i), /Unknown subcommand/);
  });
});

describe('a handler that breaks halfway', () => {
  test('says so instead of leaving the command hanging', async () => {
    // Discord shows "the application did not respond" otherwise, which tells
    // whoever ran it nothing at all.
    const i = fakeInteraction({ sub: 'join', channel: voiceChannel({ throws: true }) });

    await handleInteraction(i);

    assert.match(said(i), /Something broke: Discord said no/);
  });

  test('follows up rather than replying twice when it already deferred', async () => {
    // Replying twice to one interaction is an error from Discord, so the
    // failure path has to know which one it is on.
    const i = fakeInteraction({ sub: 'join', channel: voiceChannel() });
    i.deferReply = function deferReply() {
      this.deferred = true;
      this.calls.push(['deferReply']);
      throw new Error('boom after defer');
    };

    await handleInteraction(i);

    const kinds = i.calls.map(([kind]) => kind);
    assert.ok(kinds.includes('followUp'), `expected a followUp, got ${kinds.join(', ')}`);
    assert.ok(!kinds.includes('reply'), 'must not reply on top of a deferred interaction');
  });
});

describe('joining', () => {
  test('asks you to be in a channel when you named none', async () => {
    const i = fakeInteraction({ sub: 'join' });
    await handleInteraction(i);
    assert.match(said(i), /Join a voice channel first/);
  });

  test('refuses before connecting when it lacks Connect or Speak', async () => {
    // Better here than as a failed connection: this names the permission.
    for (const permissions of [[PermissionFlagsBits.Connect], [PermissionFlagsBits.Speak], []]) {
      const i = fakeInteraction({ sub: 'join', channel: voiceChannel({ permissions }) });
      await handleInteraction(i);
      assert.match(said(i), /Connect.*Speak/s);
    }
  });

  test('uses the channel you are in when you did not name one', async () => {
    const i = fakeInteraction({ sub: 'join', memberChannel: voiceChannel({ permissions: [] }) });
    await handleInteraction(i);
    // Reached the permission check, so it resolved the channel from voice state.
    assert.match(said(i), /Connect/);
  });
});

describe('leaving', () => {
  test('says plainly when there was nothing to leave', async () => {
    const i = fakeInteraction({ sub: 'leave', guildId: 'not-joined' });
    await handleInteraction(i);
    assert.match(said(i), /not in a voice channel/i);
  });

  test('and confirms when there was', async (t) => {
    // Driving the real registry rather than a stub: this is the one thing
    // /mj leave does, and stubbing it would leave nothing under test.
    const session = { destroyed: false, destroy() { this.destroyed = true; } };
    sessionManager.sessions.set('leaving-guild', session);
    t.after(() => sessionManager.sessions.delete('leaving-guild'));

    const i = fakeInteraction({ sub: 'leave', guildId: 'leaving-guild' });
    await handleInteraction(i);

    assert.match(said(i), /Left the channel/);
    assert.equal(session.destroyed, true);
  });
});

describe('music mode from the keyboard', () => {
  function quietable(t, { quiet = false } = {}) {
    const session = {
      destroyed: false,
      quiet,
      setQuiet(value) {
        session.quiet = value;
        return session.quiet;
      },
    };
    sessionManager.sessions.set('mute-guild', session);
    t.after(() => sessionManager.sessions.delete('mute-guild'));
    return session;
  }

  test('/mj mute turns it on and says what changes', async (t) => {
    const session = quietable(t);
    const i = fakeInteraction({ sub: 'mute', guildId: 'mute-guild' });
    await handleInteraction(i);

    assert.equal(session.quiet, true);
    assert.match(said(i), /Music mode on/);
    assert.match(said(i), /Still listening/);
  });

  test('/mj unmute turns it off', async (t) => {
    const session = quietable(t, { quiet: true });
    const i = fakeInteraction({ sub: 'unmute', guildId: 'mute-guild' });
    await handleInteraction(i);

    assert.equal(session.quiet, false);
    assert.match(said(i), /Music mode off/);
  });

  test('either one, asked for what is already true, says so', async (t) => {
    quietable(t);
    const off = fakeInteraction({ sub: 'unmute', guildId: 'mute-guild' });
    await handleInteraction(off);
    assert.match(said(off), /not in music mode/i);

    quietable(t, { quiet: true });
    const on = fakeInteraction({ sub: 'mute', guildId: 'mute-guild' });
    await handleInteraction(on);
    assert.match(said(on), /Already in music mode/);
  });

  test('both replies are ephemeral — nobody else needs them in the channel', async (t) => {
    quietable(t);
    const i = fakeInteraction({ sub: 'mute', guildId: 'mute-guild' });
    await handleInteraction(i);
    assert.ok(i.calls[0][1].flags, 'a public reply would be noise in a busy channel');
  });

  test('both are offered as subcommands, so they can be typed at all', async () => {
    const { commandData } = await import('../src/bot/commands.js');
    const names = commandData[0].options.map((o) => o.name);
    assert.ok(names.includes('mute'), 'mute is missing from the registered command');
    assert.ok(names.includes('unmute'), 'unmute is missing from the registered command');
  });
});

describe('commands that need the bot to be in a channel', () => {
  test('say so rather than doing nothing', async () => {
    for (const sub of ['transcript', 'ask', 'shush', 'mute', 'unmute', 'skip', 'pause', 'resume', 'stop', 'queue']) {
      const i = fakeInteraction({ sub, guildId: 'not-joined' });
      await handleInteraction(i);
      assert.notEqual(said(i), '', `/mj ${sub} answered nothing`);
    }
  });
});

describe('/mj play and friends', () => {
  // A fake player with the same surface the voice tools use, so the command
  // is tested for what only it does: which method it calls, with what, and
  // what it says back. The music channel note is best effort and the fake
  // guild has no channels, which is the case it must survive silently.
  function withPlayer(t, overrides = {}) {
    const calls = [];
    const music = {
      current: null,
      queue: [],
      async add(query, requestedBy) {
        calls.push(['add', query, requestedBy]);
        return { track: { title: 'Beat It', seconds: 258 }, startedNow: true, position: 1 };
      },
      skip: () => null,
      pause: () => false,
      resume: () => false,
      stop: () => calls.push(['stop']),
      ...overrides,
    };
    const session = {
      destroyed: false,
      music,
      musicStatus: () => ({ current: music.current, queue: music.queue, paused: false, volume: 100 }),
    };
    sessionManager.sessions.set('music-guild', session);
    t.after(() => sessionManager.sessions.delete('music-guild'));
    return { calls, music };
  }

  test('play hands the query to the player as typed and names who asked', async (t) => {
    const { calls } = withPlayer(t);
    const i = fakeInteraction({ sub: 'play', guildId: 'music-guild', query: '  beat it  ' });
    i.member.displayName = 'Vero';
    await handleInteraction(i);
    assert.deepEqual(calls, [['add', 'beat it', 'Vero']]);
    assert.match(said(i), /Beat It/);
    assert.match(said(i), /4:18/);
    assert.match(said(i), /Vero/);
  });

  test('play joins the channel the caller is in when the bot is in none', async () => {
    // Reaching the permission check proves it resolved the caller's channel
    // instead of asking for /mj join first.
    const i = fakeInteraction({ sub: 'play', guildId: 'not-joined', query: 'beat it', memberChannel: voiceChannel({ permissions: [] }) });
    await handleInteraction(i);
    assert.match(said(i), /Connect.*Speak/s);
  });

  test('play with nobody in a channel says where to go', async () => {
    const i = fakeInteraction({ sub: 'play', guildId: 'not-joined', query: 'beat it' });
    await handleInteraction(i);
    assert.match(said(i), /Join a voice channel/);
  });

  test('play without a query does not reach the player', async (t) => {
    const { calls } = withPlayer(t);
    const i = fakeInteraction({ sub: 'play', guildId: 'music-guild', query: '   ' });
    await handleInteraction(i);
    assert.deepEqual(calls, []);
    assert.match(said(i), /what to play/i);
  });

  test('a search that fails is reported, not thrown at the user', async (t) => {
    withPlayer(t, {
      add: async () => {
        throw new Error('nothing found');
      },
    });
    const i = fakeInteraction({ sub: 'play', guildId: 'music-guild', query: 'x' });
    await handleInteraction(i);
    assert.match(said(i), /nothing found/);
    assert.ok(!i.calls.some(([kind]) => kind === 'followUp'));
  });

  test('skip, pause, resume and stop say so when there is nothing to act on', async (t) => {
    withPlayer(t);
    for (const sub of ['skip', 'pause', 'resume', 'stop', 'queue']) {
      const i = fakeInteraction({ sub, guildId: 'music-guild' });
      await handleInteraction(i);
      assert.match(said(i), /Nothing/, `/mj ${sub}`);
    }
  });

  test('skip names what was skipped and what comes next', async (t) => {
    withPlayer(t, {
      skip: () => ({ title: 'Beat It' }),
      queue: [{ title: 'Thriller', requestedBy: 'Fede' }],
    });
    const i = fakeInteraction({ sub: 'skip', guildId: 'music-guild' });
    await handleInteraction(i);
    assert.match(said(i), /Beat It/);
    assert.match(said(i), /Thriller/);
  });

  test('queue lists what is on and what follows', async (t) => {
    const { music } = withPlayer(t);
    music.current = { title: 'Beat It', seconds: 258, requestedBy: 'Vero' };
    music.queue = [{ title: 'Thriller', requestedBy: 'Fede' }];
    const i = fakeInteraction({ sub: 'queue', guildId: 'music-guild' });
    await handleInteraction(i);
    assert.match(said(i), /Beat It.*4:18.*Vero/);
    assert.match(said(i), /1\. Thriller/);
  });
});
