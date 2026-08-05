import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';

import {
  DiscordToolError,
  describeVoice,
  disconnectMember,
  moveMember,
  requirePermission,
  resolveMember,
  setMemberMute,
  voiceMembers,
} from '../src/agent/discord-tools.js';

/** Minimum shape of a guild member these functions touch. */
function member(id, displayName, { permissions = [], channelId = 'general', muted = false } = {}) {
  const m = {
    id,
    displayName,
    nickname: null,
    user: { username: displayName.toLowerCase().replace(/\s+/g, ''), globalName: displayName },
    permissions: { has: (flag) => permissions.includes(flag) },
    voice: {
      channelId,
      serverMute: muted,
      channel: null,
      setChannel: (channel) => { m.moved = channel.id; return Promise.resolve(m); },
      disconnect: () => { m.disconnected = true; return Promise.resolve(m); },
      setMute: (value) => { m.muteSetTo = value; return Promise.resolve(m); },
    },
  };
  return m;
}

function guild(members, { botPermissions = Object.values(PermissionFlagsBits) } = {}) {
  const channels = new Map();
  for (const m of members) {
    if (!m.voice.channelId) continue;
    if (!channels.has(m.voice.channelId)) {
      channels.set(m.voice.channelId, {
        id: m.voice.channelId,
        name: m.voice.channelId,
        isVoiceBased: () => true,
        members: new Map(),
      });
    }
    const channel = channels.get(m.voice.channelId);
    channel.members.set(m.id, m);
    m.voice.channel = channel;
  }
  return {
    channels: { cache: channels },
    members: {
      cache: new Map(members.map((m) => [m.id, m])),
      me: { permissions: { has: (f) => botPermissions.includes(f) } },
    },
  };
}

const MOVE = PermissionFlagsBits.MoveMembers;
const MUTE = PermissionFlagsBits.MuteMembers;

describe('resolveMember', () => {
  const people = [
    member('1', 'Fulanito Pérez'),
    member('2', 'Mengano'),
    member('3', 'Zutano'),
  ];

  test('matches a first name out of a full display name', () => {
    assert.equal(resolveMember('fulanito', people).id, '1');
  });

  test('tolerates what transcription does to a name', () => {
    assert.equal(resolveMember('Mengáno', people).id, '2');
    assert.equal(resolveMember('sutano', people).id, '3');
  });

  test('refuses rather than guessing when nobody is close', () => {
    // Kicking the wrong person out of a call is far worse than asking again.
    assert.throws(() => resolveMember('Bartolomé', people), DiscordToolError);
    assert.throws(() => resolveMember('Bartolomé', people), /No one here matches/);
  });

  test('refuses when two people match equally well', () => {
    const twins = [member('1', 'Martín'), member('2', 'Martin')];
    assert.throws(() => resolveMember('martin', twins), /could be/);
  });

  test('says who is actually around, so the agent can ask usefully', () => {
    assert.throws(() => resolveMember('nadie', people), /Fulanito Pérez, Mengano, Zutano/);
  });

  test('refuses an empty name', () => {
    assert.throws(() => resolveMember('', people), /No name given/);
    assert.throws(() => resolveMember(undefined, people), /No name given/);
  });
});

describe('permission checks', () => {
  test('the bot is not a way around a permission you do not have', async () => {
    // The whole point: the bot holds Move Members so it can do this at all,
    // which without this check would let anyone in the call borrow it.
    //
    // Awaited on purpose: an unawaited assert.rejects passes whatever happens,
    // which would make this — the one test that matters most here — useless.
    const asker = member('1', 'Random', { permissions: [] });
    const target = member('2', 'Victim');
    const g = guild([asker, target]);

    await assert.rejects(
      () => disconnectMember(g, '1', { name: 'Victim' }),
      /doesn't have permission/,
    );
    assert.equal(target.disconnected, undefined, 'must not have acted');
  });

  test('an unknown asker gets nothing', () => {
    // No identity, no action — a request that arrived without Discord
    // attributing it to someone cannot be trusted with anyone's permissions.
    const g = guild([member('2', 'Victim')]);
    assert.throws(() => requirePermission(g, null, MOVE, 'move people'), /can't tell who's asking/);
    assert.throws(() => requirePermission(g, '999', MOVE, 'move people'), /can't tell who's asking/);
  });

  test('says so when the bot itself lacks the permission', () => {
    const asker = member('1', 'Mod', { permissions: [MOVE] });
    const g = guild([asker, member('2', 'Someone')], { botPermissions: [] });
    assert.throws(() => requirePermission(g, '1', MOVE, 'move people'), /check my role/);
  });

  test('moving and muting are separate permissions', async () => {
    const mover = member('1', 'Mover', { permissions: [MOVE] });
    const target = member('2', 'Target');
    const g = guild([mover, target]);
    // Someone who may move people may not therefore mute them.
    await assert.rejects(
      () => setMemberMute(g, '1', { name: 'Target', muted: true }),
      /permission to mute/,
    );
    assert.equal(target.muteSetTo, undefined, 'must not have acted');
  });
});

describe('actions', () => {
  test('moves someone to the asker\'s channel by default', async () => {
    const asker = member('1', 'Mod', { permissions: [MOVE], channelId: 'sala' });
    const target = member('2', 'Fulanito', { channelId: 'otra' });
    const g = guild([asker, target]);

    const said = await moveMember(g, '1', { name: 'fulanito' });
    assert.equal(target.moved, 'sala');
    assert.match(said, /Moved Fulanito to sala/);
  });

  test('does nothing when they are already where you want them', async () => {
    const asker = member('1', 'Mod', { permissions: [MOVE], channelId: 'sala' });
    const target = member('2', 'Fulanito', { channelId: 'sala' });
    const g = guild([asker, target]);

    const said = await moveMember(g, '1', { name: 'fulanito' });
    assert.equal(target.moved, undefined);
    assert.match(said, /already/);
  });

  test('mutes and unmutes', async () => {
    const asker = member('1', 'Mod', { permissions: [MUTE] });
    const target = member('2', 'Ruidoso');
    const g = guild([asker, target]);

    assert.match(await setMemberMute(g, '1', { name: 'ruidoso', muted: true }), /Muted Ruidoso/);
    assert.equal(target.muteSetTo, true);
  });

  test('disconnects', async () => {
    const asker = member('1', 'Mod', { permissions: [MOVE] });
    const target = member('2', 'Afk');
    const g = guild([asker, target]);

    assert.match(await disconnectMember(g, '1', { name: 'afk' }), /Disconnected Afk/);
    assert.equal(target.disconnected, true);
  });
});

describe('describeVoice', () => {
  test('reports who is where, and who is muted', () => {
    const g = guild([
      member('1', 'Luc', { channelId: 'general' }),
      member('2', 'Marco', { channelId: 'general', muted: true }),
    ]);
    const text = describeVoice(g);
    assert.match(text, /general: Luc, Marco \(muted\)/);
  });

  test('says plainly when nobody is around', () => {
    assert.match(describeVoice(guild([])), /Nobody is in a voice channel/);
  });
});

describe('voiceMembers', () => {
  test('is the candidate set: people in voice, each once', () => {
    const g = guild([member('1', 'A', { channelId: 'x' }), member('2', 'B', { channelId: 'y' })]);
    assert.deepEqual(voiceMembers(g).map((m) => m.id).sort(), ['1', '2']);
  });
});

describe('channel names as people actually say them', () => {
  // From a live session: the channel is "AFK - Muted (en plena paja)" and
  // someone said "AFK". Matching only the full name refused it, which is the
  // common case rather than an edge one — channel names are long and
  // decorated and nobody says the whole thing.
  function withChannels(names, asker) {
    const cache = new Map(
      names.map((name) => [name, { id: name, name, isVoiceBased: () => true, members: new Map() }]),
    );
    return {
      channels: { cache },
      members: {
        cache: new Map([[asker.id, asker]]),
        me: { permissions: { has: () => true } },
      },
    };
  }

  test('a word out of a long channel name is enough', async () => {
    const asker = member('1', 'Mod', { permissions: [MOVE], channelId: 'sala' });
    const target = member('2', 'Maki', { channelId: 'sala' });
    const g = withChannels(['AFK - Muted (en plena paja)', 'stellar-stream'], asker);
    g.channels.cache.get('stellar-stream').members.set('2', target);
    g.members.cache.set('2', target);

    await moveMember(g, '1', { name: 'maki', channel: 'AFK' });
    assert.equal(target.moved, 'AFK - Muted (en plena paja)');
  });

  test('lists the real channels when nothing matches', async () => {
    const asker = member('1', 'Mod', { permissions: [MOVE], channelId: 'sala' });
    const target = member('2', 'Maki', { channelId: 'sala' });
    const g = withChannels(['general', 'stellar-stream'], asker);
    g.channels.cache.get('general').members.set('2', target);
    g.members.cache.set('2', target);

    await assert.rejects(
      () => moveMember(g, '1', { name: 'maki', channel: 'terraza' }),
      /general, stellar-stream/,
    );
  });

  test('refuses when two channels match equally', async () => {
    const asker = member('1', 'Mod', { permissions: [MOVE], channelId: 'sala' });
    const target = member('2', 'Maki', { channelId: 'sala' });
    const g = withChannels(['Sala uno', 'Sala dos'], asker);
    g.channels.cache.get('Sala uno').members.set('2', target);
    g.members.cache.set('2', target);

    await assert.rejects(() => moveMember(g, '1', { name: 'maki', channel: 'sala' }), /could be/);
    assert.equal(target.moved, undefined);
  });
});
