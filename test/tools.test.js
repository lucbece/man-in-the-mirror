import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';

import { callTools, takePendingLeave } from '../src/agent/tools/call.js';
import { configTools } from '../src/agent/tools/config.js';
import { notebookTools } from '../src/agent/tools/notebook.js';
import { reminderTools } from '../src/agent/tools/reminders.js';
import { botToolsServer } from '../src/agent/tools/index.js';
import { reminders } from '../src/agent/reminders.js';
import { config } from '../src/config.js';
import { promptWithInstructions } from '../src/agent/brain.js';

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
      [...callTools(fakeTurn()), ...configTools(fakeTurn()), ...notebookTools(fakeTurn()), ...reminderTools('g')].map((t) => t.name),
    );

    for (const name of [
      'who_is_in_voice', 'move_member', 'disconnect_member', 'set_member_mute', 'leave_voice',
      'describe_settings', 'change_setting', 'configure_mcp_server', 'list_mcp_servers',
      'set_names', 'remember_instruction', 'list_instructions', 'forget_instruction',
      'remember_fact', 'list_facts', 'forget_fact',
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

/**
 * A call with real people in it, so an instruction saved by voice has someone
 * to be pinned to. Display names and usernames differ on purpose: the whole
 * feature is about which of the two survives a rename.
 */
function callWith(people) {
  const members = people.map(({ id, displayName, username }) => ({
    id,
    displayName,
    nickname: null,
    user: { username, globalName: displayName },
    permissions: { has: () => true },
    voice: { channelId: 'general', serverMute: false, channel: null },
  }));
  const channel = {
    id: 'general',
    name: 'general',
    isVoiceBased: () => true,
    members: new Map(members.map((m) => [m.id, m])),
  };
  for (const m of members) m.voice.channel = channel;
  return {
    channels: { cache: new Map([['general', channel]]) },
    members: {
      cache: new Map(members.map((m) => [m.id, m])),
      me: { permissions: { has: () => true } },
    },
  };
}

const FEDE = '481920374856102938';
const PATO = '102938475601928374';

describe('standing instructions that follow the person', () => {
  /** These write to the real config, so put it back whatever happens. */
  function keepInstructions(t) {
    const before = config.get('customInstructions');
    t.after(() => config.update({ customInstructions: before }));
    config.update({ customInstructions: '' });
  }

  test('pins a name said out loud to the person in the call who has it', async (t) => {
    keepInstructions(t);
    const guild = callWith([
      { id: FEDE, displayName: 'Fede', username: 'fedecito' },
      { id: PATO, displayName: 'Pato', username: 'patoo' },
    ]);
    const tools = configTools(fakeTurn({ guild }));

    await run(tools, 'remember_instruction', { instruction: 'a Fede decile tío Fede' });

    // Stored with the id, so it survives him renaming himself…
    assert.equal(config.get('customInstructions'), `a <@${FEDE}|Fede> decile tío Fede`);
    // …and only the first mention: the second is the nickname, not the person.
    assert.equal(config.get('customInstructions').match(/<@/g).length, 1);
  });

  test('leaves alone a name that is nobody in the call', async (t) => {
    keepInstructions(t);
    const guild = callWith([{ id: FEDE, displayName: 'Fede', username: 'fedecito' }]);
    const tools = configTools(fakeTurn({ guild }));

    await run(tools, 'remember_instruction', { instruction: 'a Marco tratalo de usted' });
    assert.equal(config.get('customInstructions'), 'a Marco tratalo de usted');
  });

  test('takes the model\'s word for who it meant when it says so', async (t) => {
    keepInstructions(t);
    // Two people answer to Fede; the roster alone cannot say which.
    const guild = callWith([
      { id: FEDE, displayName: 'Fede', username: 'fedecito' },
      { id: PATO, displayName: 'Fede', username: 'federicoo' },
    ]);
    const tools = configTools(fakeTurn({ guild }));

    await run(tools, 'remember_instruction', {
      instruction: 'a Fede no le sigas la corriente',
      people: [{ name: 'Fede', userId: PATO }],
    });
    assert.equal(config.get('customInstructions'), `a <@${PATO}|Fede> no le sigas la corriente`);
  });

  test('reads them back as names, and forgets one by the line it read out', async (t) => {
    keepInstructions(t);
    const guild = callWith([{ id: FEDE, displayName: 'Fede', username: 'fedecito' }]);
    await run(configTools(fakeTurn({ guild })), 'remember_instruction', {
      instruction: 'a Fede decile tío Fede',
    });

    // He renames himself. The stored line does not change; what the room
    // hears does.
    const renamed = callWith([{ id: FEDE, displayName: 'Federico', username: 'fedecito' }]);
    const tools = configTools(fakeTurn({ guild: renamed }));

    const listed = spoken(await run(tools, 'list_instructions'));
    assert.equal(listed, '1. a Federico decile tío Fede');

    const forgotten = spoken(await run(tools, 'forget_instruction', { number: 1 }));
    assert.equal(forgotten, 'Removed: a Federico decile tío Fede');
    assert.equal(config.get('customInstructions'), '');
  });

  test('with nobody in the call it is still just an instruction', async (t) => {
    keepInstructions(t);
    const tools = configTools({ guildId: 'g', askerId: null, guild: () => null });

    await run(tools, 'remember_instruction', { instruction: 'Hablá siempre en rioplatense.' });
    assert.equal(config.get('customInstructions'), 'Hablá siempre en rioplatense.');
    assert.match(spoken(await run(tools, 'list_instructions')), /1\. Hablá siempre en rioplatense\./);
  });

  test('the prompt a brain sends carries the current name, not the stored one', async (t) => {
    keepInstructions(t);
    const guild = callWith([{ id: FEDE, displayName: 'Fede', username: 'fedecito' }]);
    await run(configTools(fakeTurn({ guild })), 'remember_instruction', {
      instruction: 'a Fede decile tío Fede',
    });

    // The transcript labels his lines with whatever the guild calls him now,
    // so the prompt has to use the same word or the model cannot join them up.
    const prompt = promptWithInstructions('g', '', (id) => (id === FEDE ? 'Federico' : undefined));
    assert.match(prompt, /1\. a Federico decile tío Fede/);
    assert.ok(!prompt.includes('<@'), 'no token may reach the model');

    // An id that is nobody any more still reads as the name it was saved with.
    assert.match(promptWithInstructions('g', '', () => undefined), /1\. a Fede decile tío Fede/);
  });
});
