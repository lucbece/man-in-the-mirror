import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';

import { callTools, takePendingLeave } from '../src/agent/tools/call.js';
import { configTools } from '../src/agent/tools/config.js';
import { reminderTools } from '../src/agent/tools/reminders.js';
import { botToolsServer } from '../src/agent/tools/index.js';
import { reminders } from '../src/agent/reminders.js';

/**
 * These were unreachable until the catalogue came out of agent-brain.js.
 *
 * A family is now a function of `turn` and nothing else, so a fake turn is the
 * whole harness — no SDK session, no Discord gateway, no subprocess. What is
 * checked here is the wiring: that a tool is registered under the name the
 * prompt uses, that it refuses without crashing the turn, and that a refusal
 * arrives as a sentence rather than as an exception.
 */

/** Minimal guild: one member, whatever permissions the test wants. */
function guildWith(permissions = []) {
  const member = {
    id: 'asker',
    displayName: 'Vero',
    nickname: null,
    user: { username: 'vero', globalName: 'Vero' },
    permissions: { has: (flag) => permissions.includes(flag) },
    voice: { channelId: 'general', serverMute: false, channel: null },
  };
  const channel = {
    id: 'general',
    name: 'general',
    isVoiceBased: () => true,
    members: new Map([['asker', member]]),
  };
  member.voice.channel = channel;
  return {
    channels: { cache: new Map([['general', channel]]) },
    members: {
      cache: new Map([['asker', member]]),
      me: { permissions: { has: () => true } },
    },
  };
}

function fakeTurn({ guildId = 'g', guild = guildWith(), askerId = 'asker' } = {}) {
  return { guildId, askerId, askerName: 'Vero', guild: () => guild };
}

/** Find a tool by the name the model calls it by, and run it. */
function run(tools, name, args = {}) {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, `no tool named ${name} — the prompt refers to it by that name`);
  return found.handler(args, {});
}

const spoken = (result) => result.content.map((c) => c.text).join(' ');

describe('the catalogue the prompt refers to', () => {
  test('every tool the prompt names is registered on the bot server', () => {
    // The prompt tells the model these exist. A rename that misses the prompt
    // produces an agent that says it cannot do something it can.
    const server = botToolsServer('g', fakeTurn());
    const names = new Set(
      [...callTools(fakeTurn()), ...configTools(fakeTurn()), ...reminderTools('g')].map((t) => t.name),
    );

    for (const name of [
      'who_is_in_voice', 'move_member', 'disconnect_member', 'set_member_mute', 'leave_voice',
      'describe_settings', 'change_setting', 'configure_mcp_server', 'list_mcp_servers',
      'set_names', 'remember_instruction', 'list_instructions', 'forget_instruction',
      'set_reminder', 'list_reminders', 'cancel_reminder',
    ]) {
      assert.ok(names.has(name), `${name} is missing`);
    }
    assert.equal(server.name, 'bot', 'the reserved server name the allow-list grants');
  });
});

describe('acting on the call', () => {
  test('a refusal arrives as a sentence, not as a thrown error', async () => {
    // The turn has to survive it: the agent's job is to say "you can't do
    // that" out loud, and an exception here would kill the answer instead.
    const tools = callTools(fakeTurn({ guild: guildWith([]) }));
    const said = spoken(await run(tools, 'disconnect_member', { name: 'Vero' }));

    assert.match(said, /doesn't have permission/);
  });

  test('and so does not being connected at all', async () => {
    const tools = callTools({ guildId: 'g', askerId: 'asker', guild: () => null });
    assert.match(spoken(await run(tools, 'who_is_in_voice')), /not connected/i);
  });

  test('leaving is recorded for later, not done inside the tool call', async () => {
    // Doing it here tore down the voice session — and with it the agent
    // session — while this very call was still open. The run died with
    // stop_reason=tool_use and the bot never said a word about it.
    const tools = callTools(fakeTurn({ guildId: 'leaving' }));
    assert.match(spoken(await run(tools, 'leave_voice')), /goodbye/i);

    assert.equal(takePendingLeave('leaving'), true, 'the intent should be pending');
    assert.equal(takePendingLeave('leaving'), false, 'and taken only once');
  });
});

describe('changing the bot itself', () => {
  test('reconfiguring what runs needs more than being in the call', async () => {
    // An MCP entry carries a command that gets spawned on the host.
    const tools = configTools(fakeTurn({ guild: guildWith([PermissionFlagsBits.MoveMembers]) }));
    const said = spoken(
      await run(tools, 'configure_mcp_server', { name: 'x', configuration: '{"command":"npx"}' }),
    );

    assert.match(said, /Manage Server/);
  });

  test('a rejected value names the options, because it is read out loud', async () => {
    const tools = configTools(fakeTurn());
    const said = spoken(await run(tools, 'change_setting', { setting: 'speaking', value: 'elevenlabs' }));

    assert.match(said, /openai, local/);
  });

  test('describing the setup never reaches for a secret', async () => {
    const said = spoken(await run(configTools(fakeTurn()), 'describe_settings'));

    assert.match(said, /speaking:/);
    assert.ok(!/token|api ?key/i.test(said), `leaked something: ${said}`);
  });
});

describe('reminders', () => {
  test('registers one and can list and cancel it by the number it gave', async (t) => {
    t.after(() => reminders.clearGuild('tools-test'));
    const tools = reminderTools('tools-test');

    const set = spoken(await run(tools, 'set_reminder', { delay_minutes: 10, message: 'sacá la basura' }));
    assert.match(set, /\d+/, 'the reply has to carry the id, since cancelling needs it');

    assert.match(spoken(await run(tools, 'list_reminders')), /sacá la basura/);

    const id = reminders.list('tools-test')[0].id;
    assert.match(spoken(await run(tools, 'cancel_reminder', { id })), /cancelled/i);
    assert.equal(reminders.list('tools-test').length, 0);
  });

  test('an unreasonable ask is refused in words the bot can say', async (t) => {
    t.after(() => reminders.clearGuild('tools-test'));
    const tools = reminderTools('tools-test');

    assert.match(spoken(await run(tools, 'set_reminder', { delay_minutes: 0.01, message: 'ya' })), /too soon/i);
    assert.match(
      spoken(await run(tools, 'set_reminder', { delay_minutes: 60 * 48, message: 'pasado' })),
      /twenty-four hours/i,
    );
  });
});
