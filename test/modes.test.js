import assert from 'node:assert/strict';
import test, { after, before, beforeEach, describe } from 'node:test';

import { DEFAULT_PERSONA, MODES, describeModes, findMode, looksLikeModeCommand, modeByName, modePrompt } from '../src/agent/modes.js';
import { VOICES } from '../src/config.js';
import { botTools } from '../src/agent/tools/index.js';
import { describeServer, describeSilence, splitAddress, zomboidTools } from '../src/agent/tools/zomboid.js';
import { promptWithInstructions } from '../src/agent/brain.js';
import { config } from '../src/config.js';
import { CascadeBrain, resetCascade } from '../src/agent/cascade.js';

describe('finding the mode somebody asked for', () => {
  test('the phrasings people use, inside a whole sentence', () => {
    for (const said of [
      'espejo, activá el modo zomboid',
      'poné el modo admin',
      'ponete en modo servidor dale',
      'switch to server mode',
      'MODO ZOMBOID',
    ]) {
      assert.equal(findMode(said)?.name, 'zomboid', said);
    }
  });

  test('anything else is not a mode', () => {
    for (const said of ['qué hora es', 'poné música', '', 'modo avión']) {
      assert.equal(findMode(said), null, said);
    }
  });

  test('by name, for when the agent passes the name back', () => {
    assert.equal(modeByName('zomboid')?.name, 'zomboid');
    assert.equal(modeByName('nope'), undefined);
    assert.match(describeModes(), /"zomboid"/);
  });

  test('every mode declares what the framework needs from it', () => {
    for (const mode of MODES) {
      assert.ok(mode.name && mode.spoken?.length, `${mode.name}: name and phrasings`);
      assert.ok(mode.prompt?.trim(), `${mode.name}: its own rules`);
      assert.ok(mode.entering && mode.leaving, `${mode.name}: what it says on the way in and out`);
      // A mode that can be entered by anyone but acts as an admin is the
      // failure this pair of fields exists to make visible.
      assert.ok(mode.enterRole && mode.actRole, `${mode.name}: both gates`);
    }
  });
});

describe('asking to change character never reaches the fast leg', () => {
  test('both directions, and nothing else', () => {
    for (const said of ['activá el modo zomboid', 'ponete en modo admin', 'salí del modo', 'volvé a ser vos', 'back to normal']) {
      assert.equal(looksLikeModeCommand(said), true, said);
    }
    // Music mode has its own router; this one must not shadow it.
    for (const said of ['poné el modo música', 'mutéate', 'qué hora es', '']) {
      assert.equal(looksLikeModeCommand(said), false, said);
    }
  });
});

describe('a mode is not the room', () => {
  test('the fixed rules stay, the room\'s character goes', (t) => {
    const instructions = config.values.customInstructions;
    const notebook = config.values.notebook;
    config.values.customInstructions = 'Cuando alguien diga X respondé Y';
    config.values.notebook = 'A Fede le gusta el asado';
    t.after(() => {
      config.values.customInstructions = instructions;
      config.values.notebook = notebook;
    });

    const usual = promptWithInstructions('g1', '', () => undefined);
    assert.match(usual, /respondé Y/, 'the room writes its own character');
    assert.match(usual, /asado/);

    const inMode = promptWithInstructions('g1', modePrompt(modeByName('zomboid')), () => undefined, { room: false });
    assert.doesNotMatch(inMode, /respondé Y/, 'no standing instructions in a mode');
    assert.doesNotMatch(inMode, /asado/, 'no notebook either');
    assert.match(inMode, /You are Mirror/, 'the rules that make it audible stay');
    assert.match(inMode, /Project Zomboid/, "and the mode's own rules arrive");
    assert.match(inMode, /Never answer from memory/i, 'including the rules every mode inherits');
  });

  test('no mode adds nothing at all', () => {
    assert.equal(modePrompt(null), '');
  });
});

describe('what a mode can reach', () => {
  const turn = { guildId: 'g1', guild: () => null, askerId: null, askerName: null };
  const names = (mode) => botTools('g1', turn, mode).map((t) => t.name);

  test('everything, when it is being itself', () => {
    const all = names(null);
    for (const expected of ['set_reminder', 'remember_fact', 'change_setting', 'enter_music_mode']) {
      assert.ok(all.includes(expected), `missing ${expected}`);
    }
  });

  test('a mode keeps only its families', () => {
    const inMode = names(modeByName('zomboid'));
    // Its own list plus quiet, and nothing from the families it left out.
    assert.ok(inMode.includes('enter_music_mode'), 'it declared quiet');
    for (const gone of ['remember_fact', 'change_setting', 'set_reminder', 'play_music']) {
      assert.ok(!inMode.includes(gone), `${gone} should be out of reach in a mode`);
    }
  });

  test('the way out is always served', () => {
    // A mode whose declaration forgot to list it would otherwise be a room
    // nobody can leave by asking.
    assert.ok(names(modeByName('zomboid')).includes('leave_mode'));
    assert.ok(names({ name: 'locked', tools: [] }).includes('leave_mode'));
  });
});

describe('routing while in a mode', () => {
  beforeEach(resetCascade);

  test('the fast leg never sees the question', async () => {
    // The injectable agent is the whole point: an operational question must
    // reach the tools, and a fast model answering it out of what it happens to
    // know would sound identical and be worthless.
    let fastCalls = 0;
    const agent = {
      label: 'fake agent',
      calls: [],
      async answer(context, handlers) {
        this.calls.push(context);
        handlers.onSentence?.('from the agent');
        return 'from the agent';
      },
    };
    const brain = new CascadeBrain({
      guildId: 'g1',
      deps: {
        agent,
        runFast: async () => {
          fastCalls += 1;
          return { said: 'no', escalate: false };
        },
        getSession: async () => null,
      },
    });

    const said = await brain.answer({
      question: 'cómo está el server',
      askedBy: 'Vero',
      transcript: '',
      utterances: [],
      mode: modeByName('zomboid'),
    });
    assert.equal(said, 'from the agent');
    assert.equal(fastCalls, 0, 'a fast model must not answer an operational question');
    assert.equal(agent.calls.length, 1);
    assert.match(brain.reason, /zomboid mode/);
  });

  test('with no mode, the fast leg answers as usual', async () => {
    let fastCalls = 0;
    const brain = new CascadeBrain({
      guildId: 'g1',
      deps: {
        agent: { label: 'fake', async answer() { throw new Error('should not escalate'); } },
        runFast: async (context, memory, { onSentence } = {}) => {
          fastCalls += 1;
          onSentence?.('Porque sí.');
          return { said: 'Porque sí.', escalate: false };
        },
        getSession: async () => null,
      },
    });
    const said = await brain.answer({ question: 'por qué', askedBy: 'Vero', transcript: '', utterances: [] });
    assert.equal(said, 'Porque sí.');
    assert.equal(fastCalls, 1);
  });
});

describe('what the zomboid mode can see', () => {
  test('the address can be written with or without a port', () => {
    assert.deepEqual(splitAddress('10.0.0.1:16261'), { host: '10.0.0.1', port: 16261 });
    assert.deepEqual(splitAddress('game.example.com'), { host: 'game.example.com', port: 16261 });
    assert.deepEqual(splitAddress(' 10.0.0.1:17000 '), { host: '10.0.0.1', port: 17000 });
    assert.equal(splitAddress(''), null);
    assert.equal(splitAddress(undefined), null);
  });

  test('a server that answers is reported by what it said, not by configuration', () => {
    const said = describeServer({
      name: 'PandaParkour',
      map: 'Muldraugh, KY',
      players: 3,
      maxPlayers: 16,
      version: '42.20',
    });
    assert.match(said, /PandaParkour/);
    assert.match(said, /3 of 16 playing/);
    assert.match(said, /42\.20/);
  });

  test('an empty server says so plainly', () => {
    assert.match(describeServer({ name: 'x', map: 'y', players: 0, maxPlayers: 16, version: '42' }), /nobody playing/);
  });

  test('silence is the normal state, and the way out is somebody else\'s command', () => {
    const said = describeSilence();
    // The two things this wording exists for: not calling a nightly, designed
    // shutdown a fault, and not letting the bot claim a switch it has not got.
    assert.match(said, /powers itself off/);
    assert.match(said, /\/pz start/);
    assert.match(said, /Never say that you started it/);
  });

  test('the zomboid family is what the mode declared', () => {
    const turn = { guildId: 'g1', guild: () => null, askerId: null, askerName: null };
    const names = botTools('g1', turn, modeByName('zomboid')).map((t) => t.name);
    assert.ok(names.includes('zomboid_status'));
    assert.ok(names.includes('leave_mode'));
    assert.ok(!names.includes('remember_fact'));
  });
});

describe('a character has a name and a voice', () => {
  test('every mode is asked for by name, and says which name', () => {
    for (const mode of MODES) {
      assert.ok(mode.displayName, `${mode.name}: nothing to call it`);
      assert.ok(
        mode.spoken.some((phrase) => phrase.includes(mode.name)),
        `${mode.name}: none of its phrasings contain its own name`,
      );
    }
  });

  test('switching is asked for by name, and the wake word is not a switch', () => {
    // The ambiguity this design exists to remove: "espejo" starts every single
    // thing anybody says to the bot, so a bare name can never mean "change
    // character". Only a verb-and-name phrasing does.
    assert.equal(looksLikeModeCommand('que venga el bot de zomboid'), true);
    assert.equal(looksLikeModeCommand('que vuelva espejo'), true);
    assert.equal(looksLikeModeCommand('volvé a ser vos'), true);
    assert.equal(looksLikeModeCommand('espejo, qué hora es'), false);
    assert.equal(looksLikeModeCommand('espejo, cómo está el server'), false);
  });

  test('asking for the default back is a switch that names no mode', () => {
    // leave_mode's job, not enter_mode's: findMode has nothing to return.
    assert.equal(findMode('que vuelva espejo'), null);
    assert.equal(findMode('que venga el bot de zomboid')?.name, 'zomboid');
  });

  test('the default persona is named, so there is something to ask back for', () => {
    assert.equal(DEFAULT_PERSONA.name, 'espejo');
    // Not a bare name anywhere: that is the wake word.
    for (const phrase of DEFAULT_PERSONA.spoken) {
      assert.ok(phrase.trim().includes(' '), `"${phrase}" is a bare word and would fire constantly`);
    }
  });

  test('a mode with its own voice picks a real one', () => {
    for (const mode of MODES) {
      if (!mode.voice) continue;
      assert.ok(VOICES.includes(mode.voice), `${mode.name}: ${mode.voice} is not an OpenAI voice`);
      assert.notEqual(mode.voice, 'onyx', `${mode.name}: the same voice as the room's is a costume`);
    }
  });
});

describe('asking the operator that lives on the server', () => {
  let configured;
  before(() => {
    configured = config.values.zomboidSsh;
    config.values.zomboidSsh = 'pz@10.0.0.1';
  });
  after(() => {
    config.values.zomboidSsh = configured;
  });

  const guild = {
    members: {
      cache: new Map([
        ['kpo', { displayName: 'Luc', roles: { cache: [{ name: 'los kpos' }] } }],
        ['nadie', { displayName: 'Fede', roles: { cache: [{ name: 'BOTS' }] } }],
      ]),
      me: {},
    },
    channels: { cache: new Map() },
  };
  // A text channel that records what was written into it.
  function withChannel(name) {
    const posted = [];
    const channel = {
      name,
      isTextBased: () => true,
      isVoiceBased: () => false,
      permissionsFor: () => ({ has: () => true }),
      send: async (text) => posted.push(text),
    };
    return { posted, guild: { ...guild, channels: { cache: new Map([['c', channel]]) } } };
  }
  const turnFor = (askerId, g = guild) => ({
    guildId: 'g1',
    guild: () => g,
    askerId,
    askerName: 'Luc',
  });
  const toolNamed = (tools, name) => tools.find((t) => t.name === name);
  const textOf = (result) => result.content[0].text;

  test('a question only looks, and needs no role', async () => {
    const seen = [];
    const tools = zomboidTools(turnFor('nadie'), {
      keyPath: '/dev/null',
      ask: async (args) => {
        seen.push(args);
        return { ok: true, spoken: 'Está arriba, hay tres jugando.' };
      },
    });
    const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: '¿anda?' }));
    assert.match(said, /Está arriba/);
    assert.equal(seen[0].act, false, 'reading by default');
  });

  test('acting is refused without the role, and the refusal is sayable', async () => {
    const tools = zomboidTools(turnFor('nadie'), {
      keyPath: '/dev/null',
      ask: async () => {
        throw new Error('should never be asked');
      },
    });
    const said = textOf(
      await toolNamed(tools, 'zomboid_ask').handler({ question: 'reinicialo', act: true }),
    );
    assert.match(said, /los kpos/, 'says which role it needs');
    assert.match(said, /Fede/);
  });

  test('acting goes through for somebody who has it', async () => {
    const seen = [];
    const tools = zomboidTools(turnFor('kpo'), {
      keyPath: '/dev/null',
      ask: async (args) => {
        seen.push(args);
        return { ok: true, spoken: 'Listo, reiniciado.' };
      },
    });
    const said = textOf(
      await toolNamed(tools, 'zomboid_ask').handler({ question: 'reinicialo', act: true }),
    );
    assert.match(said, /reiniciado/);
    assert.equal(seen[0].act, true);
  });

  test('the long half is written, not spoken, and the voice says so', async () => {
    const { posted, guild: g } = withChannel('project-zomboid-ñoños-chatroom');
    const tools = zomboidTools(turnFor('kpo', g), {
      keyPath: '/dev/null',
      ask: async () => ({
        ok: true,
        spoken: 'Se cayó por un mod. Te lo dejo escrito.',
        detail: '## Qué encontré\nEl mod BetterSorting no cargó.',
      }),
    });
    const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: '¿por qué se cayó?' }));
    assert.equal(posted.length, 1, 'the report went to the channel');
    assert.match(posted[0], /BetterSorting/);
    assert.match(said, /Se cayó por un mod/);
    assert.match(said, /written in the channel/i, 'and the voice mentions it');
  });

  test('with nowhere configured to ask, it says so instead of failing', async () => {
    const ssh = config.values.zomboidSsh;
    config.values.zomboidSsh = '';
    try {
      const tools = zomboidTools(turnFor('kpo'), { keyPath: '/dev/null', ask: async () => ({}) });
      const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: 'hola' }));
      assert.match(said, /no way in|cannot ask/i);
    } finally {
      config.values.zomboidSsh = ssh;
    }
  });

  test('a door that answers nothing sayable does not go silent', async () => {
    const tools = zomboidTools(turnFor('kpo'), {
      keyPath: '/dev/null',
      ask: async () => ({ ok: false, error: 'sin cupo' }),
    });
    const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: 'hola' }));
    assert.match(said, /could not get a clear answer/i);
  });
});
