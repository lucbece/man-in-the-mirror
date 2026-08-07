/**
 * Acting on the voice call itself: who is around, moving people, muting,
 * disconnecting, leaving.
 *
 * Every one of these checks the permissions of *whoever asked*, never the
 * bot's — the reasoning is in discord-tools.js, and it is the whole security
 * model: the bot must not become a way around a permission someone does not
 * have.
 */
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

import {
  describeVoice,
  disconnectMember,
  moveMember,
  setMemberMute,
} from '../discord-tools.js';
import { discordTool } from './wrappers.js';

/**
 * Guilds where the agent has asked to leave once it stops talking.
 *
 * Leaving cannot happen inside the tool call that requests it. Found in use:
 * "traelo a Maki de vuelta y desconectate vos" moved Maki, then called
 * leave_voice, which destroyed the voice session — which ends the agent
 * session — while that very tool call was still open. Both actions actually
 * happened, but the run died with `stop_reason=tool_use` and the bot never
 * said a word about it.
 *
 * So the tool records the intent and returns; the leave happens once the
 * answer has finished playing, which is also when you'd want it to. It gets
 * to say goodbye before it goes.
 */
const wantsToLeave = new Set();

/** Whether this guild's agent asked to leave, clearing the request. */
export function takePendingLeave(guildId) {
  return wantsToLeave.delete(guildId);
}

export function callTools(turn) {
  return [
      tool(
        'who_is_in_voice',
        'List who is in which voice channel right now, and who is muted. Use this before acting on someone, and to answer questions about who is around.',
        {},
        discordTool(turn, async (guild) => describeVoice(guild)),
      ),
      tool(
        'move_member',
        "Move someone to a voice channel. Without a channel, they are brought to the asker's channel. Only works if the person asking has permission to move members.",
        {
          name: z.string().describe('Who to move, as the speaker said it.'),
          channel: z.string().optional().describe('Voice channel to move them to. Omit to bring them here.'),
        },
        discordTool(turn, (guild, askerId, args) => moveMember(guild, askerId, args)),
      ),
      tool(
        'disconnect_member',
        'Disconnect someone from voice. Only works if the person asking has permission to move members.',
        { name: z.string().describe('Who to disconnect, as the speaker said it.') },
        discordTool(turn, (guild, askerId, args) => disconnectMember(guild, askerId, args)),
      ),
      tool(
        'set_member_mute',
        'Server-mute or unmute someone in voice. Only works if the person asking has permission to mute members.',
        {
          name: z.string().describe('Who to mute or unmute, as the speaker said it.'),
          muted: z.boolean().describe('true to mute, false to unmute.'),
        },
        discordTool(turn, (guild, askerId, args) => setMemberMute(guild, askerId, args)),
      ),
      tool(
        'leave_voice',
        'Leave the voice channel. Use when asked to disconnect, go away, or stop listening.',
        {},
        async () => {
          wantsToLeave.add(turn.guildId);
          return {
            content: [
              {
                type: 'text',
                text: 'Leaving as soon as you finish speaking. Say a short goodbye now.',
              },
            ],
          };
        },
      ),
  ];
}
