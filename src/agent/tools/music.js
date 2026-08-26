/**
 * Driving the server's music bot by typing its commands for you.
 *
 * There is already a bot in the server that plays music when somebody posts
 * `m!p something` in a text channel. This does not replace it — it types for
 * you, so "espejo, poné Beat It" works from a voice call without anyone
 * reaching for a keyboard.
 *
 * The interesting problem is not Discord, it is transcription. Song and artist
 * names are exactly what speech recognition is worst at: proper nouns, often
 * English ones said inside a Spanish sentence. "Beat It de Michael Jackson"
 * comes back as "bit it", "bidi", "beat eat". Posting that verbatim queues the
 * wrong song, or nothing.
 *
 * So the correction happens before the command is posted, and it happens in
 * the model rather than here. It knows the catalogue; a string-matching rule
 * in this file never would. What this file enforces is that the correction is
 * *said out loud* — the room is the last check on a wrong guess, and it can
 * only catch it if it hears it.
 *
 * The permission model is the same as everywhere else: posting through the bot
 * must not be a way into a channel you could not post in yourself.
 */
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { PermissionFlagsBits } from 'discord.js';

import { config } from '../../config.js';
import { DiscordToolError } from '../discord-tools.js';
import { discordTool } from './wrappers.js';

/**
 * The text channel the music bot listens in, or a refusal saying why not.
 *
 * Matched loosely for the same reason channel names are matched loosely
 * everywhere else here: people name them "music", "🎵-music", "música".
 */
function musicChannel(guild) {
  const wanted = config.get('musicChannel').trim().toLowerCase();
  if (!wanted) {
    throw new DiscordToolError('No music channel is configured, so I have nowhere to post that.');
  }

  const channels = [...guild.channels.cache.values()].filter(
    (channel) => channel.isTextBased?.() && !channel.isVoiceBased?.(),
  );
  const found =
    channels.find((c) => c.name.toLowerCase() === wanted) ??
    channels.find((c) => c.name.toLowerCase().includes(wanted));

  if (!found) {
    throw new DiscordToolError(`I can't find a text channel called "${wanted}" in this server.`);
  }
  return found;
}

/**
 * Post a command, having checked that the asker could have posted it too.
 *
 * Without that check the bot is a way to type in a channel someone has been
 * kept out of — the same borrowed-permissions problem as moving people between
 * voice channels, with the same answer.
 */
async function postCommand(guild, askerId, text, { what }) {
  const channel = musicChannel(guild);
  const asker = askerId ? guild.members.cache.get(askerId) : null;
  if (!asker) {
    throw new DiscordToolError(`I can't tell who's asking, so I won't ${what}.`);
  }

  const theirs = channel.permissionsFor(asker);
  if (!theirs?.has(PermissionFlagsBits.SendMessages)) {
    throw new DiscordToolError(`${asker.displayName} can't post in ${channel.name}, so neither will I.`);
  }
  const mine = channel.permissionsFor(guild.members.me);
  if (!mine?.has(PermissionFlagsBits.SendMessages)) {
    throw new DiscordToolError(`I can't post in ${channel.name} — check my permissions there.`);
  }

  await channel.send(text);
  return channel;
}

/**
 * Links the music bot knows how to resolve.
 *
 * Anything else is either not music or something it will choke on, and a bot
 * posting arbitrary URLs into a channel on somebody's say-so is a different
 * feature with different questions attached.
 */
const PLAYABLE_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'open.spotify.com',
  'soundcloud.com',
  'www.soundcloud.com',
];

function asUrl(text) {
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * A link may only be posted if this turn actually looked something up.
 *
 * The failure this prevents is quiet, which is what makes it worse than the
 * wrong-song one. A mis-corrected title plays something and the room says "esa
 * no"; a fabricated playlist id plays *nothing*, in a text channel nobody in a
 * voice call is looking at, while the bot says "listo, puse la playlist".
 *
 * And fabricating one is the likely case rather than the unlucky one: playlist
 * ids are opaque strings, so a model asked for one from memory produces
 * something well-formed and invented. Asked after a search, it copies a real
 * one out of the results.
 *
 * The difference is provenance, and provenance is not something a prompt can
 * be trusted to enforce — so this checks that the search happened. It cannot
 * prove the link came *from* those results, but it does mean real ones were in
 * front of it, which is the whole gap between the two cases.
 *
 * Verifying the link instead would be better and is not available: fetching a
 * YouTube playlist from a server gets a bot-check page, and a real playlist and
 * an invented one come back byte-identical. Measured, not assumed.
 */
function checkLink(url, turn) {
  if (!PLAYABLE_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new DiscordToolError(
      `${url.hostname} isn't somewhere the music bot can play from.`,
    );
  }
  if (!turn?.searched) {
    throw new DiscordToolError(
      'Search for it first and use a link from the results — a link written from memory usually does not exist, and it fails silently.',
    );
  }
}

export function musicTools(turn) {
  return [
    tool(
      'play_music',
      'Queue music in the server\'s music channel: a song, an artist, or a whole album. Use this whenever someone asks for something to be played or put on.\n\n' +
        'Fix what speech recognition mangled before you call this. Song and artist names come through badly, especially English ones inside a Spanish sentence — "bit it michael jackson" is Beat It, "el disco de rumores de fleetwood mac" is the album Rumours. Write what they meant, not what the transcript says.\n\n' +
        'If you do not recognise the title but they named something specific, search once to confirm it exists, then queue it. A wrong title queues the wrong song, and nobody in the call can see what you typed.\n\n' +
        'If they did not name a title or an artist you can identify, ASK THEM. Half a lyric, "esa que suena en la peli", a description of what the song is about — none of those is a query. Never build a title out of their description and queue it: "the one about a footballer" is not a song called Jugador de Fútbol, and queueing that plays something nobody asked for while sounding certain. Say what you are missing and stop. They know which song it is; the search does not.\n\n' +
        'For a playlist, paste its link — that is the only way to queue a whole playlist rather than one track. Search for it first and copy the link out of the results, exactly. Never write a link from memory: playlist ids are opaque, one you invent looks perfectly normal and plays nothing at all, in a channel nobody in the call can see. Then say the playlist\'s name out loud, not the link.\n\n' +
        'For anything else, write it the way a person types into a search box: the title and the artist, nothing else. Do not append words like "song", "album" or "full" that were not part of the name — this is a search query, so every extra word changes what it finds.\n\n' +
        'Always say out loud what you queued, including the artist. The room is the only thing that can catch a wrong correction, and it can only do that if it hears one.',
      {
        query: z
          .string()
          .describe(
            'What to search for, corrected and written out: "Beat It Michael Jackson", ' +
              '"Rumours Fleetwood Mac". Title and artist only, no command prefix — ' +
              'that is added for you.',
          ),
      },
      discordTool(turn, async (guild, askerId, { query }) => {
        const wanted = String(query ?? '').trim();
        if (!wanted) throw new DiscordToolError('You have to tell me what to play.');

        const url = asUrl(wanted);
        if (url) checkLink(url, turn);
        // Newlines would post a second, unintended command; the prefix in the
        // query itself would double it up.
        const clean = wanted.replace(/\s+/g, ' ');

        const channel = await postCommand(
          guild,
          askerId,
          `${config.get('musicPlayCommand')} ${clean}`,
          { what: 'queue music' },
        );
        return `Queued "${clean}" in ${channel.name}. Say what you put on, including the artist, so they can correct you if it was heard wrong.`;
      }),
    ),
    tool(
      'skip_song',
      'Skip whatever is playing and move to the next thing in the queue.',
      {},
      discordTool(turn, async (guild, askerId) => {
        const channel = await postCommand(guild, askerId, config.get('musicSkipCommand'), {
          what: 'skip the song',
        });
        return `Skipped, in ${channel.name}.`;
      }),
    ),
  ];
}
