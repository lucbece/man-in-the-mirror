/**
 * Music, played by the bot itself.
 *
 * The first version of this typed `m!p` into a text channel for the music bot
 * that was already in the server. It cannot work, and the reason is Discord
 * rather than anything we wrote: a bot's message carries `author.bot = true`,
 * and essentially every bot drops those in its first line to avoid loops.
 * Measured both ways — as the bot and through a webhook, with a command
 * confirmed to work when a person typed it — and neither got a reply. A
 * webhook message is still flagged as a bot.
 *
 * So the bot plays it, which is the better answer anyway: it knows what is on,
 * it can pause for a question instead of talking over the song, and a playlist
 * link does not depend on some other bot agreeing to accept it.
 *
 * What survives from the first version is the part that was never about
 * Discord: song and artist names are what speech recognition is worst at.
 * "Beat It de Michael Jackson" arrives as "bit it de maikel yakson", so the
 * correction happens in the model, before the search, and it says out loud
 * what it found so the room can catch a wrong guess.
 */
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { sessionManager } from '../../voice/manager.js';
import { DiscordToolError } from '../discord-tools.js';
import { speakableTool } from './wrappers.js';

/** The session for this turn's guild, or a refusal that says why not. */
function musicFor(turn) {
  const session = sessionManager.get(turn.guildId);
  if (!session || session.destroyed) {
    throw new DiscordToolError("I'm not in a voice channel, so there's nowhere to play it.");
  }
  return session;
}

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function musicTools(turn) {
  return [
    tool(
      'play_music',
      'Play a song, an artist or an album in the voice channel, or add it to the queue if something is already playing.\n\n' +
        'Fix what speech recognition mangled before you call this. Song and artist names come through badly, especially English ones inside a Spanish sentence — "bit it michael jackson" is Beat It, "el disco de rumores de fleetwood mac" is the album Rumours. Write what they meant, not what the transcript says.\n\n' +
        'If they did not name something you can identify, ASK THEM. Half a lyric or "esa que suena en la peli" is not a query, and a title you build out of their description plays something nobody asked for while sounding certain.\n\n' +
        'A link works too — paste a YouTube or playlist URL and it plays that. Search for the link first and copy it exactly; one written from memory looks fine and plays nothing.\n\n' +
        'The tool tells you the real title it found. Say that out loud, not what you searched for: it is the only way the room learns you heard them right.',
      {
        query: z
          .string()
          .describe('The song, artist or album to look for, corrected — or a URL.'),
      },
      speakableTool(async ({ query }) => {
        const wanted = String(query ?? '').trim();
        if (!wanted) throw new DiscordToolError('You have to tell me what to play.');

        const session = musicFor(turn);
        const { track, startedNow, position } = await session.music.add(
          wanted,
          turn.askerName ?? 'someone',
        );

        return startedNow
          ? `Playing "${track.title}" (${mmss(track.seconds)}). Say that title out loud — it is what they will hear, and how they find out if you searched for the wrong thing.`
          : `Queued "${track.title}" at position ${position}. Say the title, and that something is already playing.`;
      }),
    ),
    tool(
      'skip_song',
      'Skip whatever is playing and move to the next thing in the queue.',
      {},
      speakableTool(async () => {
        const session = musicFor(turn);
        const skipped = session.music.skip();
        if (!skipped) return 'Nothing is playing.';
        const next = session.music.queue[0];
        return next
          ? `Skipped "${skipped.title}". Next is "${next.title}".`
          : `Skipped "${skipped.title}". Nothing else is queued.`;
      }),
    ),
    tool(
      'stop_music',
      'Stop the music and clear the queue. Use when asked to stop playing, not when asked to skip.',
      {},
      speakableTool(async () => {
        const session = musicFor(turn);
        if (!session.music.playing) return 'Nothing is playing.';
        session.music.stop();
        return 'Stopped, and the queue is cleared.';
      }),
    ),
    tool(
      'now_playing',
      'What is playing right now, and what is queued behind it.',
      {},
      speakableTool(async () => {
        const { current, queue } = musicFor(turn).musicStatus();
        if (!current) return 'Nothing is playing.';
        const rest = queue.length
          ? ` Then: ${queue.slice(0, 3).map((t) => t.title).join(', ')}${queue.length > 3 ? `, and ${queue.length - 3} more` : ''}.`
          : ' Nothing queued after it.';
        return `"${current.title}", asked for by ${current.requestedBy}.${rest}`;
      }),
    ),
  ];
}
