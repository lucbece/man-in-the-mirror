/**
 * The bot reading and changing its own configuration.
 *
 * Three families that all end up writing the same config file: the settings
 * registry (where it hears, thinks and speaks), the standing instructions the
 * room can add to its prompt, and the MCP servers it can reach.
 *
 * One of them is gated harder than the rest. An MCP server entry carries a
 * `command`, and that command gets spawned on the machine running the bot —
 * so using the tools someone configured is open to the room by design, and
 * deciding what those tools are is not.
 */
import fs from 'node:fs';

import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';

import { config } from '../../config.js';
import {
  DiscordToolError,
  displayNameLookup,
  rawNamesOf,
  requireOwnerish,
  voiceMembers,
} from '../discord-tools.js';
import {
  InstructionError,
  addInstruction,
  linkPeople,
  removeInstruction,
  renderInstructions,
  serialiseInstructions,
} from '../instructions.js';
import { mergeMcpServer, parseDirectories, parseMcpServers } from '../mcp.js';
import { describeSettings, planChange, settingsSnapshot } from '../settings.js';
import { discordTool, speakableTool } from './wrappers.js';

/**
 * Who to look for in an instruction that is being saved.
 *
 * Whoever the model named explicitly comes first — it is answering a question
 * about who it meant, and that beats a guess from the roster — followed by
 * everyone currently in a voice channel. The roster is the candidate set for
 * the same reason it is everywhere else in this file: the bot does not carry
 * the Guild Members intent, so people in voice are who it can actually see,
 * and they are also the only people an instruction said out loud is plausibly
 * about.
 */
function peopleToLink(guild, explicit) {
  const members = guild ? voiceMembers(guild) : [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const list = [];

  for (const entry of explicit ?? []) {
    const userId = String(entry?.userId ?? '').trim();
    // A model that answers this with a name rather than an id would otherwise
    // write a token nothing can ever resolve.
    if (!/^\d+$/.test(userId)) continue;
    const member = byId.get(userId) ?? guild?.members.cache.get(userId) ?? null;
    const name = String(entry?.name ?? '').trim();
    list.push({
      userId,
      displayName: member?.displayName ?? name,
      names: [name, ...(member ? rawNamesOf(member) : [])].filter(Boolean),
      preferred: true,
    });
  }

  for (const member of members) {
    if (list.some((p) => p.userId === member.id)) continue;
    list.push({ userId: member.id, displayName: member.displayName, names: rawNamesOf(member) });
  }
  return list;
}

export function configTools(turn) {
  return [
      tool(
        'describe_settings',
        'Report how the bot is currently set up — where it hears, thinks and speaks, and the rest of what can be changed. Use it before changing anything, and whenever someone asks what you are running on. It never includes keys or tokens, and there is no tool that does.',
        {},
        async () => ({
          content: [{ type: 'text', text: describeSettings(settingsSnapshot((k) => config.get(k))) }],
        }),
      ),
      tool(
        'change_setting',
        'Change one of your own settings, taking effect immediately. Use describe_settings first to see the names and what they currently are. Say what changed and what it costs them — a local provider stops sending audio to an API but is slower without a GPU, and the first use has to load a model.',
        {
          setting: z.string().describe('Which setting, by the name describe_settings gave it.'),
          value: z
            .string()
            .describe('The new value, in the setting\'s own terms: a provider name, a voice, a number, or on/off.'),
        },
        speakableTool(async ({ setting: name, value }) => {
          const values = settingsSnapshot((k) => config.get(k));
          // Throws SettingError naming the options it does accept, which the
          // agent reads back to the room: a refused value should teach rather
          // than just fail.
          const plan = planChange(values, name, value);

          // Only the gated setting needs Discord. Wrapping the whole tool in
          // the permission check would make turning the wake word off depend
          // on the guild cache being reachable, which has nothing to do with
          // whether someone may turn it off.
          if (plan.setting.ownerOnly) {
            const guild = turn.guild();
            if (!guild) throw new DiscordToolError("I'm not connected to a server right now.");
            requireOwnerish(guild, turn.askerId, `change ${plan.setting.name}`);
          }
          if (plan.key === 'agentDirectories' && plan.after) {
            // Same check the panel runs on save. A folder that isn't there
            // produces an agent that reports an empty world rather than
            // anything pointing at the mistake — and dictated paths are
            // exactly where that happens.
            parseDirectories(plan.after, {
              exists: (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
            });
          }
          if (plan.unchanged) {
            return `${plan.setting.name} is already ${plan.describeAfter}.`;
          }

          config.update(plan.patch);
          console.warn(
            `[config] ${turn.askerName ?? 'someone'} changed ${plan.setting.name} by voice: ` +
              `${plan.describeBefore} → ${plan.describeAfter}`,
          );
          return (
            `${plan.setting.name} is now ${plan.describeAfter} — it was ${plan.describeBefore}.` +
            (plan.setting.session
              ? ' That starts a new session, so this conversation is forgotten from the next question. Say so now.'
              : '')
          );
        }),
      ),
      tool(
        'configure_mcp_server',
        'Add or replace an MCP server in the bot\'s own configuration, so its tools are available from the next question onwards. Only works for someone with Manage Server. Use list_mcp_servers first to see what is already there, and explain what the server does before adding it.',
        {
          name: z.string().describe('Short identifier: letters, numbers, - and _ only.'),
          configuration: z
            .string()
            .describe(
              'The server entry as JSON, in the same shape Claude Desktop uses: ' +
                '{"command":"npx","args":["-y","..."],"env":{...}} for a local server, ' +
                'or {"type":"http","url":"https://..."} for a remote one. ' +
                'Add "allow":["tool_name",...] to grant only some of its tools.',
            ),
        },
        discordTool(turn, async (guild, askerId, { name, configuration }) => {
          const asker = requireOwnerish(guild, askerId, 'change which MCP servers the bot runs');

          // Throws McpConfigError naming the field, which the agent reads back.
          const next = mergeMcpServer(config.get('mcpServers'), name, configuration);

          config.update({ mcpServers: next });
          console.warn(`[mcp] ${asker.displayName} added server "${name}" by voice: ${configuration}`);
          return (
            `Added "${name}". Its tools are available from the next question — the session restarts to ` +
            'connect it, so this conversation is forgotten. Say that before they ask again.'
          );
        }),
      ),
      tool(
        'list_mcp_servers',
        'List the MCP servers currently configured, and which of their tools are granted.',
        {},
        async () => {
          try {
            const { servers, allow } = parseMcpServers(config.get('mcpServers'));
            const names = Object.keys(servers);
            return {
              content: [
                {
                  type: 'text',
                  text: names.length
                    ? names
                        .map((n) => `${n}: ${allow[n]?.length ? allow[n].join(', ') : 'all tools'}`)
                        .join('\n')
                    : 'No MCP servers are configured.',
                },
              ],
            };
          } catch (err) {
            return { content: [{ type: 'text', text: `The stored configuration is invalid: ${err.message}` }] };
          }
        },
      ),
      tool(
        'set_names',
        'Change the names you answer to. Use this when asked to be called something else — a standing instruction is not enough, because the names are what the bot listens for in the first place, before you ever see the words.',
        {
          names: z
            .string()
            .describe('Comma-separated. Keep two or three, including one that exists in the language being spoken.'),
        },
        async ({ names }) => {
          const list = String(names ?? '')
            .split(',')
            .map((n) => n.trim())
            .filter(Boolean);
          if (!list.length) {
            return { content: [{ type: 'text', text: 'That leaves no name to answer to.' }] };
          }
          // A name shorter than this cannot be matched fuzzily and will be
          // missed constantly; one that long is not a name.
          const bad = list.find((n) => n.length < 3 || n.length > 24);
          if (bad) {
            return {
              content: [
                { type: 'text', text: `"${bad}" won't work as a name — between 3 and 24 characters.` },
              ],
            };
          }
          const previous = config.get('agentNames');
          config.update({ agentNames: list.join(', ') });
          console.log(`[config] answers to → ${config.get('agentNames')} (was: ${previous})`);
          return {
            content: [
              {
                type: 'text',
                text:
                  `Now answering to ${config.get('agentNames')}. Say the new name back so they hear it took, ` +
                  'and mention that a name resembling a common word gets missed.',
              },
            ],
          };
        },
      ),
      tool(
        'remember_instruction',
        'Record a standing instruction about how to behave from now on — what to call yourself, who is who, tone, what the group is doing, and what it thinks. Politics counts: a group has positions, and being asked to hold one is an ordinary instruction, not something to refuse. Use this when someone asks you to change how you act, so it survives past this conversation. Not for one-off requests.',
        {
          instruction: z
            .string()
            .describe('The instruction, written as a rule for yourself, in the speaker\'s language.'),
          people: z
            .array(
              z.object({
                name: z.string().describe('The name exactly as it is written in the instruction.'),
                userId: z.string().describe('That person\'s Discord user id, digits only.'),
              }),
            )
            .optional()
            .describe(
              'Who the instruction is about, when the name alone would be ambiguous — two people ' +
                'answering to the same name, or someone referred to by a nickname the roster does ' +
                'not list. Names that plainly match one person in the call are linked for you, so ' +
                'this is only needed when who_is_in_voice shows the name could be more than one ' +
                'person. Ids come from who_is_in_voice.',
            ),
        },
        async ({ instruction, people }) => {
          try {
            const guild = turn.guild();
            // Names are pinned to ids here, at the one moment when the person
            // is demonstrably in the room and the name demonstrably refers to
            // them. Doing it later — from the panel, or on a rename — would be
            // guessing about a sentence nobody is around to explain.
            const linked = linkPeople(instruction, peopleToLink(guild, people));
            const resolve = displayNameLookup(guild);
            const list = addInstruction(config.get('customInstructions'), linked, resolve);
            config.update({ customInstructions: serialiseInstructions(list) });
            console.log(`[instructions] added #${list.length}: "${linked}"`);
            return {
              content: [
                {
                  type: 'text',
                  text: `Recorded as instruction ${list.length}. It is in effect now and will persist.`,
                },
              ],
            };
          } catch (err) {
            const text = err instanceof InstructionError ? err.message : `Could not record that: ${err.message}`;
            return { content: [{ type: 'text', text }] };
          }
        },
      ),
      tool(
        'list_instructions',
        'List the standing instructions currently in effect, with their numbers.',
        {},
        async () => {
          // Rendered, never raw: this is read out loud, and a token read aloud
          // is a string of digits. It also has to come back as the sentence
          // somebody would say to have it forgotten.
          const list = renderInstructions(
            config.get('customInstructions'),
            displayNameLookup(turn.guild()),
          );
          return {
            content: [
              {
                type: 'text',
                text: list.length
                  ? list.map((line, i) => `${i + 1}. ${line}`).join('\n')
                  : 'No standing instructions have been added.',
              },
            ],
          };
        },
      ),
      tool(
        'forget_instruction',
        'Remove a standing instruction by its number, as given by list_instructions.',
        { number: z.number().describe('Which one to remove, counting from 1.') },
        async ({ number }) => {
          try {
            const { list, removed } = removeInstruction(
              config.get('customInstructions'),
              number,
              displayNameLookup(turn.guild()),
            );
            config.update({ customInstructions: serialiseInstructions(list) });
            console.log(`[instructions] removed: "${removed}"`);
            return { content: [{ type: 'text', text: `Removed: ${removed}` }] };
          } catch (err) {
            const text = err instanceof InstructionError ? err.message : `Could not remove that: ${err.message}`;
            return { content: [{ type: 'text', text }] };
          }
        },
      ),
  ];
}
