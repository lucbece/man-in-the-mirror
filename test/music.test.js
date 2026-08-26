import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';

import { musicTools } from '../src/agent/tools/music.js';
import { config } from '../src/config.js';

const SEND = PermissionFlagsBits.SendMessages;

/** A guild with one text channel and one member, plus whatever they can do. */
function guildWith({
  channelName = 'music',
  asker = [SEND],
  bot = [SEND],
  voiceChannel = false,
} = {}) {
  const posted = [];
  const member = { id: 'asker', displayName: 'Luc' };
  const channel = {
    id: 'c1',
    name: channelName,
    isTextBased: () => true,
    isVoiceBased: () => voiceChannel,
    permissionsFor: (who) => ({
      has: (flag) => (who === member ? asker : bot).includes(flag),
    }),
    send: (text) => {
      posted.push(text);
      return Promise.resolve({ id: 'm1' });
    },
  };
  return {
    posted,
    channels: { cache: new Map([['c1', channel]]) },
    members: { cache: new Map([['asker', member]]), me: { id: 'bot' } },
  };
}

const turnFor = (guild, askerId = 'asker') => ({
  guildId: 'g',
  askerId,
  askerName: 'Luc',
  guild: () => guild,
});

function run(guild, name, args = {}, askerId = 'asker') {
  const tools = musicTools(turnFor(guild, askerId));
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `no tool named ${name}`);
  return found.handler(args, {});
}

const spoken = (result) => result.content.map((c) => c.text).join(' ');

describe('queueing music', () => {
  test('posts the command the music bot listens for', async () => {
    const guild = guildWith();
    const said = spoken(await run(guild, 'play_music', { query: 'Beat It Michael Jackson' }));

    assert.deepEqual(guild.posted, ['m!p Beat It Michael Jackson']);
    assert.match(said, /Queued/);
  });

  test('albums are just a longer query, not a different command', async () => {
    const guild = guildWith();
    await run(guild, 'play_music', { query: 'Rumours Fleetwood Mac' });

    assert.deepEqual(guild.posted, ['m!p Rumours Fleetwood Mac']);
  });

  test('tells it to say what it queued, because nobody in voice can see the channel', async () => {
    // The room is the only check on a wrong correction, and it can only catch
    // one if it hears it.
    const guild = guildWith();
    const said = spoken(await run(guild, 'play_music', { query: 'Beat It Michael Jackson' }));

    assert.match(said, /say what you put on/i);
    assert.match(said, /artist/i);
  });

  test('a newline cannot smuggle in a second command', async () => {
    const guild = guildWith();
    await run(guild, 'play_music', { query: 'Beat It\nm!skip' });

    assert.equal(guild.posted.length, 1);
    assert.ok(!guild.posted[0].includes('\n'), `posted a second line: ${guild.posted[0]}`);
  });

  test('refuses an empty request rather than posting a bare prefix', async () => {
    const guild = guildWith();
    assert.match(spoken(await run(guild, 'play_music', { query: '   ' })), /what to play/i);
    assert.deepEqual(guild.posted, []);
  });

  test('skipping posts its own command', async () => {
    const guild = guildWith();
    assert.match(spoken(await run(guild, 'skip_song')), /Skipped/);
    assert.deepEqual(guild.posted, ['m!skip']);
  });
});

describe('who is allowed to type through the bot', () => {
  test('someone who cannot post there cannot post there through the bot', async () => {
    // Same borrowed-permissions problem as moving people between voice
    // channels: the bot must not be a way into a channel you are kept out of.
    const guild = guildWith({ asker: [] });
    const said = spoken(await run(guild, 'play_music', { query: 'Beat It' }));

    assert.match(said, /can't post in music/);
    assert.deepEqual(guild.posted, [], 'and nothing was posted');
  });

  test('an unidentified asker is refused', async () => {
    const guild = guildWith();
    assert.match(spoken(await run(guild, 'play_music', { query: 'Beat It' }, null)), /can't tell who/i);
    assert.deepEqual(guild.posted, []);
  });

  test('says so plainly when the bot itself cannot post', async () => {
    const guild = guildWith({ bot: [] });
    assert.match(spoken(await run(guild, 'play_music', { query: 'Beat It' })), /check my permissions/);
  });
});

describe('finding the channel', () => {
  test('matches a decorated name, since nobody calls it exactly "music"', async () => {
    const guild = guildWith({ channelName: '🎵-music-room' });
    await run(guild, 'play_music', { query: 'Beat It' });

    assert.equal(guild.posted.length, 1);
  });

  test('says which channel it looked for when there is none', async () => {
    const guild = guildWith({ channelName: 'general' });
    assert.match(spoken(await run(guild, 'play_music', { query: 'Beat It' })), /can't find.*"music"/);
  });

  test('a voice channel of the same name is not where commands go', async () => {
    const guild = guildWith({ voiceChannel: true });
    assert.match(spoken(await run(guild, 'play_music', { query: 'Beat It' })), /can't find/);
  });

  test('follows the configured name, whatever the server calls it', async (t) => {
    // Every music bot and every server names this differently, so it is a
    // setting rather than a constant.
    const before = config.get('musicChannel');
    t.after(() => config.update({ musicChannel: before }));
    config.update({ musicChannel: 'cancionero' });

    const guild = guildWith({ channelName: 'cancionero' });
    await run(guild, 'play_music', { query: 'Beat It' });

    assert.deepEqual(guild.posted, ['m!p Beat It']);
  });

  test('blank restores the default rather than switching the tools off', async (t) => {
    // `update` treats an empty string as "back to the default" for every
    // non-secret setting, so there is no way to blank this — and no need:
    // a server with no such channel gets a refusal that says so.
    const before = config.get('musicChannel');
    t.after(() => config.update({ musicChannel: before }));

    config.update({ musicChannel: '' });
    assert.equal(config.get('musicChannel'), 'music');
  });
});

describe('queueing a playlist by link', () => {
  const YT = 'https://www.youtube.com/playlist?list=PL1kFzkeJ3uKJRA6oJFycrUhuzYYTn7jn6';

  /** A turn that has, or has not, looked something up yet. */
  const turnThat = (searched, guild) => ({
    guildId: 'g',
    askerId: 'asker',
    askerName: 'Luc',
    searched,
    guild: () => guild,
  });

  function runWith(turn, args) {
    const found = musicTools(turn).find((t) => t.name === 'play_music');
    return found.handler(args, {});
  }

  test('posts a link that came out of a search', async () => {
    const guild = guildWith();
    const said = spoken(await runWith(turnThat(true, guild), { query: YT }));

    assert.deepEqual(guild.posted, [`m!p ${YT}`]);
    assert.match(said, /Queued/);
  });

  test('refuses one written from memory, because that fails silently', async () => {
    // The whole point. A mis-corrected title plays the wrong song and the room
    // says "esa no". An invented playlist id plays nothing, in a channel
    // nobody in a voice call is looking at, while the bot says it worked.
    const guild = guildWith();
    const said = spoken(await runWith(turnThat(false, guild), { query: YT }));

    assert.match(said, /Search for it first/);
    assert.deepEqual(guild.posted, [], 'and nothing was posted');
  });

  test('a plain search query never needs a search first', async () => {
    // Only links carry the provenance problem: a title that is wrong is
    // audible, so it does not need this.
    const guild = guildWith();
    await runWith(turnThat(false, guild), { query: 'Beat It Michael Jackson' });

    assert.deepEqual(guild.posted, ['m!p Beat It Michael Jackson']);
  });

  test('only from somewhere the music bot can play', async () => {
    const guild = guildWith();
    const said = spoken(
      await runWith(turnThat(true, guild), { query: 'https://evil.example/thing' }),
    );

    assert.match(said, /isn't somewhere the music bot can play from/);
    assert.deepEqual(guild.posted, []);
  });

  test('spotify and the short youtube form count too', async () => {
    for (const link of [
      'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
      'https://youtu.be/oRdxUFDoQe0',
      'https://music.youtube.com/playlist?list=PLjtl0SgBBa2cs5HfpVYjv_-BEv_Xrbcn0',
    ]) {
      const guild = guildWith();
      await runWith(turnThat(true, guild), { query: link });
      assert.deepEqual(guild.posted, [`m!p ${link}`], link);
    }
  });
});
