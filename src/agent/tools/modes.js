/**
 * Stepping into a mode, and back out.
 *
 * The two tools that make agent/modes.js reachable from a voice call. Shaped
 * on quiet.js, which is the same idea with one mode hard-coded into it: a
 * switch nobody is going to open a control panel for, because the moment you
 * want it is the moment you are already talking.
 *
 * Entering is gated on a Discord role the mode names. Leaving is not: a bot
 * that can be put into a character and not taken out of it by whoever is in
 * the room is a bot that will be left in that character, and the way out has
 * to be at least as easy as the way in.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { sessionManager } from '../../voice/manager.js';
import { DiscordToolError, requireRole } from '../discord-tools.js';
import { describeModes, findMode, modeByName } from '../modes.js';
import { discordTool, speakableTool } from './wrappers.js';

/** The voice session for this turn, or a refusal that says why not. */
function sessionFor(turn) {
  const session = sessionManager.get(turn.guildId);
  if (!session || session.destroyed) {
    throw new DiscordToolError("I'm not in a voice channel, so there is no mode to change.");
  }
  return session;
}

export function modeTools(turn) {
  return [
    tool(
      'enter_mode',
      'Become one of your other characters, with its own rules and its own tools.\n\n' +
        `The ones that exist: ${describeModes()}.\n\n` +
        'Use this when somebody asks for one by name — "activá el modo zomboid", "ponete en modo admin", "switch to server mode". ' +
        'Each mode says who may turn it on, and you will be refused if they may not; say the refusal out loud as it comes back.\n\n' +
        'Once you are in one, everything you were before — the room\'s standing instructions, the jokes, the tools that have nothing to do with the job — is set aside until somebody takes you out of it.',
      { mode: z.string().describe('The mode to enter, by its name or by what they said.') },
      discordTool(turn, async (guild, askerId, { mode: asked }) => {
        const session = sessionFor(turn);
        const mode = modeByName(asked) ?? findMode(asked);
        if (!mode) {
          throw new DiscordToolError(
            `There is no "${asked}" mode. The ones that exist: ${describeModes()}.`,
          );
        }
        if (session.mode === mode.name) {
          return `Already in the ${mode.name} mode. Say so in a few words.`;
        }
        if (mode.enterRole) requireRole(guild, askerId, mode.enterRole, `put you in the ${mode.name} mode`);
        session.setMode(mode.name);
        console.log(`[mode] entered ${mode.name} (asked by ${turn.askerName ?? 'unknown'})`);
        return (
          `You are in the ${mode.name} mode now. Say this, or something very close to it, and nothing else: ` +
          `"${mode.entering}"`
        );
      }),
    ),
    tool(
      'leave_mode',
      'Go back to being your usual self, ending whatever mode you are in.\n\n' +
        'Use this for "salí del modo", "volvé a ser vos", "listo, gracias", "leave the mode", "back to normal". ' +
        'Anyone can ask for this, whoever put you in the mode.',
      {},
      speakableTool(async () => {
        const session = sessionFor(turn);
        const mode = modeByName(session.mode);
        if (!mode) return 'Not in any mode right now. Say so in a word or two.';
        session.setMode(null);
        console.log(`[mode] left ${mode.name} (asked by ${turn.askerName ?? 'unknown'})`);
        return `Out of the ${mode.name} mode. Say this, or something very close: "${mode.leaving}"`;
      }),
    ),
  ];
}
