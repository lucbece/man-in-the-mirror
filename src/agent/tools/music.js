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

import { PermissionFlagsBits } from 'discord.js';

import { config } from '../../config.js';
import { sessionManager } from '../../voice/manager.js';
import { DiscordToolError } from '../discord-tools.js';
import { speakableTool } from './wrappers.js';

/**
 * Write down what is playing, in the channel people already watch for that.
 *
 * Best effort on purpose. The music playing is the point; the note is how the
 * room learns *which* track, which matters because these commands are carried
 * out without saying anything. If the channel is missing or the bot cannot
 * post there, the song still plays and nobody is told about a failure that
 * changed nothing.
 *
 * Written rather than spoken because a title is exactly what a listener
 * mishears, and the whole reason this correction exists is that speech
 * recognition mangled it on the way in.
 */
export async function noteInMusicChannel(turn, text) {
  try {
    const guild = turn.guild?.();
    const wanted = config.get('musicChannel').trim().toLowerCase();
    if (!guild || !wanted) return;

    const channels = [...guild.channels.cache.values()].filter(
      (c) => c.isTextBased?.() && !c.isVoiceBased?.(),
    );
    const channel =
      channels.find((c) => c.name.toLowerCase() === wanted) ??
      channels.find((c) => c.name.toLowerCase().includes(wanted));
    if (!channel?.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) return;

    await channel.send(text);
  } catch (err) {
    console.warn(`[music] could not write to the channel: ${err.message}`);
  }
}

/** The session for this turn's guild, or a refusal that says why not. */
function musicFor(turn) {
  const session = sessionManager.get(turn.guildId);
  if (!session || session.destroyed) {
    throw new DiscordToolError("I'm not in a voice channel, so there's nowhere to play it.");
  }
  return session;
}

export const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

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

        const who = turn.askerName ?? 'someone';
        await noteInMusicChannel(
          turn,
          startedNow
            ? `▶️  **${track.title}**  ·  ${mmss(track.seconds)}  ·  pedido por ${who}`
            : `➕  **${track.title}**  ·  en cola (${position})  ·  pedido por ${who}`,
        );

        return startedNow
          ? `Playing "${track.title}". Written in the music channel too, so say nothing unless they asked something as well.`
          : `Queued "${track.title}" at position ${position}. Written in the music channel too, so say nothing unless they asked something as well.`;
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
        await noteInMusicChannel(turn, `⏭️  saltado: ${skipped.title}${next ? `  →  **${next.title}**` : ''}`);
        return next
          ? `Skipped "${skipped.title}", now playing "${next.title}". Say nothing — they will hear it.`
          : `Skipped "${skipped.title}", nothing else queued. Say nothing — they will hear the silence.`;
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
        await noteInMusicChannel(turn, '⏹️  música detenida, cola vacía');
        return 'Stopped and cleared. Say nothing — they will hear it stop.';
      }),
    ),
    tool(
      'play_album',
      'Queue a whole album, track by track. Use this whenever someone asks for a record rather than a song — "poné Californication entero", "el disco Rumours".\n\n' +
        'List the tracks yourself, in order. You know most albums; if you are not sure of the running order, search for it first. Never refuse because you cannot find a single video of the album — an album on YouTube is its songs, and queueing them individually is how it gets played.\n\n' +
        'Each track is looked up when its turn comes, so this returns immediately and the first song starts while the rest wait.',
      {
        artist: z.string().describe('The artist, as it is written.'),
        album: z.string().describe('The album, as it is written.'),
        tracks: z
          .array(z.string())
          .describe('The track titles in order. Titles only — the artist is added for you.'),
      },
      speakableTool(async ({ artist, album, tracks }) => {
        const session = musicFor(turn);
        const list = (tracks ?? []).map((t) => String(t).trim()).filter(Boolean);
        if (!list.length) throw new DiscordToolError('I need the track list to queue an album.');

        const { queued, startedNow, dropped } = await session.music.addMany(
          list.map((title) => `${title} ${artist}`),
          turn.askerName ?? 'someone',
        );
        await noteInMusicChannel(
          turn,
          `💿  **${album}** — ${artist}  ·  ${queued} temas  ·  pedido por ${turn.askerName ?? 'alguien'}`,
        );
        return (
          `Queued ${queued} tracks from ${album}${dropped ? `, ${dropped} did not fit` : ''}` +
          `${startedNow ? ' and the first is playing' : ''}. Say nothing — they can hear it.`
        );
      }),
    ),
    tool(
      'remove_from_queue',
      'Take something out of the queue that has not played yet. Say which by its title, or by its number in the queue.',
      {
        which: z.string().describe('Part of the title, or its position in the queue as a number.'),
      },
      speakableTool(async ({ which }) => {
        const session = musicFor(turn);
        const removed = session.music.remove(which);
        await noteInMusicChannel(turn, `➖  fuera de la cola: ${removed.title}`);
        return `Removed "${removed.title}" from the queue. Say nothing — nothing changed in what they can hear.`;
      }),
    ),
    tool(
      'move_in_queue',
      'Move something already queued to a different place — "poné esa primera", "esa dejala para el final".',
      {
        which: z.string().describe('Part of the title, or its current position as a number.'),
        to: z.number().describe('Where it should go, counting from 1.'),
      },
      speakableTool(async ({ which, to }) => {
        const session = musicFor(turn);
        const { track, position } = session.music.move(which, to);
        await noteInMusicChannel(turn, `↕️  ${track.title} → posición ${position}`);
        return `Moved "${track.title}" to position ${position}. Say nothing.`;
      }),
    ),
    tool(
      'pause_music',
      'Pause what is playing, keeping it where it is. Use for "pará un segundo", not for "pará la música" — that is stop_music, which clears the queue.',
      {},
      speakableTool(async () => {
        const session = musicFor(turn);
        return session.music.pause()
          ? 'Paused. Say nothing — they can hear it stop.'
          : 'Nothing is playing, or it was already paused.';
      }),
    ),
    tool(
      'resume_music',
      'Carry on from where it was paused.',
      {},
      speakableTool(async () => {
        const session = musicFor(turn);
        return session.music.resume()
          ? 'Playing again. Say nothing.'
          : 'It was not paused.';
      }),
    ),
    tool(
      'set_volume',
      'Turn the music up or down. Use `change` for "bajale un poco" or "subilo" — negative to lower, positive to raise, in percentage points; a nudge is about 15. Use `level` only when they name a number, like "ponelo al treinta".',
      {
        change: z
          .number()
          .optional()
          .describe('Relative step in percentage points: -15 to lower a little, 15 to raise.'),
        level: z.number().optional().describe('Absolute level, 0 to 150. Only when they said a number.'),
      },
      speakableTool(async ({ change, level }) => {
        if (change === undefined && level === undefined) {
          throw new DiscordToolError('Say whether to turn it up or down.');
        }
        const session = musicFor(turn);
        const { from, to, atLimit, applied } = session.music.setVolume({ change, level });

        if (!applied) {
          return `Volume set to ${to} percent, but nothing is playing yet — it will apply to the next track. Say that, since there is nothing for them to hear.`;
        }
        if (from === to) {
          return atLimit
            ? `Already at ${to} percent, which is as far as it goes. Say so — this one they cannot hear.`
            : `Volume unchanged at ${to} percent.`;
        }
        await noteInMusicChannel(turn, `🔊  volumen: ${from}% → ${to}%`);
        return `Volume ${to > from ? 'up' : 'down'} to ${to} percent. Say nothing — they can hear it.`;
      }),
    ),
    tool(
      'now_playing',
      'What is playing right now, and what is queued behind it.',
      {},
      speakableTool(async () => {
        const { current, queue } = musicFor(turn).musicStatus();
        if (!current) return 'Nothing is playing.';
        const level = musicFor(turn).music.volume;
        const rest = queue.length
          ? ` Then: ${queue.slice(0, 3).map((t) => t.title).join(', ')}${queue.length > 3 ? `, and ${queue.length - 3} more` : ''}.`
          : ' Nothing queued after it.';
        return `"${current.title}", asked for by ${current.requestedBy}, at ${level} percent volume.${rest}`;
      }),
    ),
  ];
}
