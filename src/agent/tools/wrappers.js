/**
 * How a tool says no.
 *
 * Every tool here can legitimately refuse — a name that matches nobody, a
 * permission the asker doesn't have, a value that isn't one of the options —
 * and a refusal is something the agent has to say out loud, not a crash that
 * kills the turn. Both wrappers turn a thrown error into text and log it.
 *
 * The difference is only whether the tool needs Discord. `discordTool` fetches
 * the guild and fails early without one; `speakableTool` is for the tools that
 * reject values rather than people and need no guild at all.
 */
import { McpConfigError } from '../mcp.js';
import { SettingError } from '../settings.js';
import { DiscordToolError } from '../discord-tools.js';
import { ReminderError } from '../reminders.js';

/**
 * Errors that are already sentences.
 *
 * A malformed server entry or a folder that isn't there reads fine as speech
 * and has nothing to do with Discord, so attributing it to Discord would send
 * the agent looking for a permission problem that doesn't exist.
 */
function isSpeakable(err) {
  return (
    err instanceof DiscordToolError ||
    err instanceof McpConfigError ||
    err instanceof SettingError ||
    err instanceof ReminderError
  );
}

/**
 * Wrap a Discord action so a refusal reaches the agent as words rather than a
 * crash. Every one of these can legitimately say no — wrong name, missing
 * permission, nobody by that name in the call — and the agent's job is then to
 * say so out loud.
 */
export function discordTool(turn, run) {
  return async (args) => {
    try {
      const guild = turn.guild();
      if (!guild) throw new DiscordToolError("I'm not connected to a server right now.");
      const text = await run(guild, turn.askerId, args);
      console.log(`[discord] ${text} (asked by ${turn.askerName ?? 'unknown'})`);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      // These tools also reject values — a malformed server entry, a folder
      // that isn't there. Those already read as sentences and are not
      // Discord's doing, so attributing them to Discord would send the agent
      // looking for a permission problem that doesn't exist.
      const message = isSpeakable(err) ? err.message : `Discord refused: ${err.message}`;
      console.log(`[discord] refused: ${message}`);
      return { content: [{ type: 'text', text: message }] };
    }
  };
}

/**
 * Wrap a tool whose refusals are already sentences.
 *
 * Same contract as `discordTool` — say no in words rather than crashing the
 * turn — for the tools that reject values rather than people, and so need no
 * guild to do their job.
 */
export function speakableTool(run) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: await run(args) }] };
    } catch (err) {
      const message = isSpeakable(err) ? err.message : `That didn't work: ${err.message}`;
      console.log(`[config] refused: ${message}`);
      return { content: [{ type: 'text', text: message }] };
    }
  };
}
