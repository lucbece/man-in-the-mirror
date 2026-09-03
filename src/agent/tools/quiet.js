/**
 * Music mode: the switch that makes the bot stop talking.
 *
 * The bot pauses the music to speak, which is right for a question and wrong
 * for a room that has put a record on. Turning listening off is not the answer
 * either — people still want to skip a track, queue the next one, and ask it
 * to talk again — so what is switched off is only the voice.
 *
 * Reached by voice because that is the situation it is for: the music is
 * already loud, and nobody is going to open Discord to type a command. The
 * descriptions below therefore carry the phrasings people actually use, in
 * both languages the room speaks, rather than a tidy paraphrase of them.
 *
 * The flag itself lives on the voice session (`voice/session.js`), and so ends
 * when the bot leaves the channel. It is deliberately not a setting: a bot
 * that came back from a restart silently mute would look broken.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { sessionManager } from '../../voice/manager.js';
import { DiscordToolError } from '../discord-tools.js';
import { speakableTool } from './wrappers.js';

/** The session for this turn's guild, or a refusal that says why not. */
function sessionFor(turn) {
  const session = sessionManager.get(turn.guildId);
  if (!session || session.destroyed) {
    throw new DiscordToolError("I'm not in a voice channel, so there is nothing to quieten.");
  }
  return session;
}

export function quietTools(turn) {
  return [
    tool(
      'enter_music_mode',
      'Stop speaking out loud until you are told otherwise, so nothing you say cuts into the music.\n\n' +
        'Use this whenever they ask you to be quiet for a while rather than to stop one sentence: "mutéate", "modo música", "callate hasta que te avise", "no hables mientras suena", "mute yourself", "stay quiet while the music is on".\n\n' +
        'You keep listening and you keep doing things — skipping, queueing, everything — and what you would have said is written into the music channel instead. So carry on answering normally; only your voice is gone.\n\n' +
        'Not for "callate" said to one sentence in flight: that is them wanting this answer to stop, not the next hour of them.',
      {},
      speakableTool(async () => {
        const session = sessionFor(turn);
        if (session.quiet) {
          return 'Already in music mode. Say a short line acknowledging it — it will be written, not spoken.';
        }
        session.setQuiet(true);
        return (
          'Music mode is on: nothing you say from here is spoken out loud. ' +
          'Say a short line confirming it anyway — it goes into the music channel, so the room reads that you understood.'
        );
      }),
    ),
    tool(
      'leave_music_mode',
      'Start speaking out loud again, ending music mode.\n\n' +
        'Use this for "hablá de nuevo", "salí del modo música", "desmuteate", "ya podés hablar", "you can talk again", "unmute yourself", "stop being quiet".\n\n' +
        'Your answer to this one is heard, so confirm it out loud in a few words — that confirmation is how the room learns your voice is back.',
      {},
      speakableTool(async () => {
        const session = sessionFor(turn);
        if (!session.quiet) return 'I was not in music mode. Say so briefly.';
        session.setQuiet(false);
        return 'Music mode is off and your voice is back. Say a short line out loud confirming it.';
      }),
    ),
  ];
}
