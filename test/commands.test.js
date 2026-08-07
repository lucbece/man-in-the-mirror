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
      getString: () => null,
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

describe('commands that need the bot to be in a channel', () => {
  test('say so rather than doing nothing', async () => {
    for (const sub of ['listen', 'deaf', 'transcript', 'ask', 'shush']) {
      const i = fakeInteraction({ sub, guildId: 'not-joined' });
      await handleInteraction(i);
      assert.notEqual(said(i), '', `/mj ${sub} answered nothing`);
    }
  });
});
