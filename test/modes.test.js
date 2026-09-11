import assert from 'node:assert/strict';
import test, { after, before, beforeEach, describe } from 'node:test';

import { DEFAULT_PERSONA, characters, describeModes, findMode, looksLikeModeCommand, modeByName, modePrompt } from '../src/agent/modes.js';
import { VOICES } from '../src/config.js';
import { botTools } from '../src/agent/tools/index.js';
import { DoorMissing, KeyRefused, describeServer, describeSilence, lateAnswers, splitAddress, sshArgs, zomboidTools } from '../src/agent/tools/zomboid.js';
import { promptWithInstructions } from '../src/agent/brain.js';
import { config } from '../src/config.js';
import { CascadeBrain, resetCascade } from '../src/agent/cascade.js';

/**
 * A character invented for these tests.
 *
 * The repository ships none: a character names a Discord role, a channel and a
 * job, which are facts about one group of people. So the tests write their own
 * rather than borrowing anybody's, which also proves the thing worth proving —
 * that the framework has no favourite character built into it.
 */
const CHARACTER = {
  name: 'faro',
  displayName: 'el bot del faro',
  spoken: ['bot del faro', 'modo faro', 'lighthouse mode'],
  enterRole: 'guardianes',
  actRole: 'guardianes',
  detailChannel: 'sala-de-maquinas',
  voice: 'echo',
  tools: ['zomboid', 'quiet'],
  entering: 'Soy el bot del faro.',
  leaving: 'Listo, vuelve espejo.',
  prompt: '\n\n# This mode\n\nYou look after a lighthouse. Say what is true and stop.',
};

before(() => {
  config.values.characters = JSON.stringify([CHARACTER]);
});
after(() => {
  config.values.characters = '';
});

describe('finding the mode somebody asked for', () => {
  test('the phrasings people use, inside a whole sentence', () => {
    for (const said of [
      'espejo, activá el modo faro',
      'poné el bot del faro',
      'ponete en modo faro dale',
      'switch to lighthouse mode',
      'MODO FARO',
    ]) {
      assert.equal(findMode(said)?.name, 'faro', said);
    }
  });

  test('anything else is not a mode', () => {
    for (const said of ['qué hora es', 'poné música', '', 'modo avión']) {
      assert.equal(findMode(said), null, said);
    }
  });

  test('by name, for when the agent passes the name back', () => {
    assert.equal(modeByName('faro')?.name, 'faro');
    assert.equal(modeByName('nope'), undefined);
    assert.match(describeModes(), /"faro"/);
  });

  test('every mode declares what the framework needs from it', () => {
    for (const mode of characters()) {
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
    for (const said of ['activá el modo faro', 'ponete en el bot del faro', 'salí del modo', 'volvé a ser vos', 'back to normal']) {
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

    const inMode = promptWithInstructions('g1', modePrompt(modeByName('faro')), () => undefined, { room: false });
    assert.doesNotMatch(inMode, /respondé Y/, 'no standing instructions in a mode');
    assert.doesNotMatch(inMode, /asado/, 'no notebook either');
    assert.match(inMode, /You are Mirror/, 'the rules that make it audible stay');
    assert.match(inMode, /lighthouse/i, "and the mode's own rules arrive");
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
    const inMode = names(modeByName('faro'));
    // Its own list plus quiet, and nothing from the families it left out.
    assert.ok(inMode.includes('enter_music_mode'), 'it declared quiet');
    for (const gone of ['remember_fact', 'change_setting', 'set_reminder', 'play_music']) {
      assert.ok(!inMode.includes(gone), `${gone} should be out of reach in a mode`);
    }
  });

  test('the way out is always served', () => {
    // A mode whose declaration forgot to list it would otherwise be a room
    // nobody can leave by asking.
    assert.ok(names(modeByName('faro')).includes('leave_mode'));
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
      question: 'cómo está el faro',
      askedBy: 'Vero',
      transcript: '',
      utterances: [],
      mode: modeByName('faro'),
    });
    assert.equal(said, 'from the agent');
    assert.equal(fastCalls, 0, 'a fast model must not answer an operational question');
    assert.equal(agent.calls.length, 1);
    assert.match(brain.reason, /faro mode/);
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
      name: 'El Refugio 42',
      map: 'Muldraugh, KY',
      players: 3,
      maxPlayers: 16,
      version: '42.20',
    });
    assert.match(said, /El Refugio 42/);
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
    const names = botTools('g1', turn, modeByName('faro')).map((t) => t.name);
    assert.ok(names.includes('zomboid_status'));
    assert.ok(names.includes('leave_mode'));
    assert.ok(!names.includes('remember_fact'));
  });
});

describe('a character has a name and a voice', () => {
  test('every mode is asked for by name, and says which name', () => {
    for (const mode of characters()) {
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
    assert.equal(looksLikeModeCommand('que venga el bot del faro'), true);
    assert.equal(looksLikeModeCommand('que vuelva espejo'), true);
    assert.equal(looksLikeModeCommand('volvé a ser vos'), true);
    assert.equal(looksLikeModeCommand('espejo, qué hora es'), false);
    assert.equal(looksLikeModeCommand('espejo, cómo está el server'), false);
  });

  test('asking for the default back is a switch that names no mode', () => {
    // leave_mode's job, not enter_mode's: findMode has nothing to return.
    assert.equal(findMode('que vuelva espejo'), null);
    assert.equal(findMode('que venga el bot del faro')?.name, 'faro');
  });

  test('the default persona is named, so there is something to ask back for', () => {
    assert.equal(DEFAULT_PERSONA.name, 'espejo');
    // Not a bare name anywhere: that is the wake word.
    for (const phrase of DEFAULT_PERSONA.spoken) {
      assert.ok(phrase.trim().includes(' '), `"${phrase}" is a bare word and would fire constantly`);
    }
  });

  test('a mode with its own voice picks a real one', () => {
    for (const mode of characters()) {
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
        ['kpo', { displayName: 'Vero', roles: { cache: [{ name: 'guardianes' }] } }],
        ['nadie', { displayName: 'Nico', roles: { cache: [{ name: 'BOTS' }] } }],
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
    askerName: 'Vero',
  });
  const toolNamed = (tools, name) => tools.find((t) => t.name === name);
  const textOf = (result) => result.content[0].text;

  test('a question only looks, and needs no role', async () => {
    const seen = [];
    const tools = zomboidTools(turnFor('nadie'), {
      keys: { read: '/dev/null', act: '/dev/null' },
      ask: async (args) => {
        seen.push(args);
        return { ok: true, spoken: 'Está arriba, hay tres jugando.' };
      },
    }, modeByName('faro'));
    const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: '¿anda?' }));
    assert.match(said, /Está arriba/);
    assert.equal(seen[0].act, false, 'reading by default');
  });

  test('acting is refused without the role, and the refusal is sayable', async () => {
    const tools = zomboidTools(turnFor('nadie'), {
      keys: { read: '/dev/null', act: '/dev/null' },
      ask: async () => {
        throw new Error('should never be asked');
      },
    }, modeByName('faro'));
    const said = textOf(
      await toolNamed(tools, 'zomboid_ask').handler({ question: 'reinicialo', act: true }),
    );
    assert.match(said, /guardianes/, 'says which role it needs');
    assert.match(said, /Nico/);
  });

  test('acting goes through for somebody who has it', async () => {
    const seen = [];
    const tools = zomboidTools(turnFor('kpo'), {
      keys: { read: '/dev/null', act: '/dev/null' },
      ask: async (args) => {
        seen.push(args);
        return { ok: true, spoken: 'Listo, reiniciado.' };
      },
    }, modeByName('faro'));
    const said = textOf(
      await toolNamed(tools, 'zomboid_ask').handler({ question: 'reinicialo', act: true }),
    );
    assert.match(said, /reiniciado/);
    assert.equal(seen[0].act, true);
  });

  test('the long half is written, not spoken, and the voice says so', async () => {
    const { posted, guild: g } = withChannel('sala-de-maquinas');
    const tools = zomboidTools(turnFor('kpo', g), {
      keys: { read: '/dev/null', act: '/dev/null' },
      ask: async () => ({
        ok: true,
        spoken: 'Se cayó por un mod. Te lo dejo escrito.',
        detail: '## Qué encontré\nEl mod BetterSorting no cargó.',
      }),
    }, modeByName('faro'));
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
      const tools = zomboidTools(turnFor('kpo'), { keys: { read: '/dev/null', act: '/dev/null' }, ask: async () => ({}) }, modeByName('faro'));
      const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: 'hola' }));
      assert.match(said, /no way in|cannot ask/i);
    } finally {
      config.values.zomboidSsh = ssh;
    }
  });

  test('which key is used is the permission, not a flag', async () => {
    const seen = [];
    const tools = zomboidTools(turnFor('kpo'), {
      keys: { read: '/read-key', act: '/act-key' },
      ask: async (args) => {
        seen.push(args.keyPath);
        return { ok: true, spoken: 'listo' };
      },
    }, modeByName('faro'));
    const ask = toolNamed(tools, 'zomboid_ask');
    await ask.handler({ question: '¿anda?' });
    await ask.handler({ question: 'reinicialo', act: true });
    assert.deepEqual(seen, ['/read-key', '/act-key']);
  });

  test('without the second key it can only look, and says which key is missing', async () => {
    const tools = zomboidTools(turnFor('kpo'), {
      keys: { read: '/dev/null', act: '/does/not/exist' },
    }, modeByName('faro'));
    const said = textOf(
      await toolNamed(tools, 'zomboid_ask').handler({ question: 'reinicialo', act: true }),
    );
    assert.match(said, /only have the key that lets me look/i);
  });

  test('a machine that is asleep is not a machine that is broken', async () => {
    // The VM powers itself off after half an hour with nobody playing, so ssh
    // failing is the normal evening rather than a fault. The cheap probe
    // decides which, instead of the failure of the expensive call.
    const address = config.values.zomboidAddress;
    config.values.zomboidAddress = '';
    try {
      const tools = zomboidTools(turnFor('kpo'), {
        keys: { read: '/dev/null', act: '/dev/null' },
        ask: async () => {
          throw new Error('ssh: connect to host port 22: Connection timed out');
        },
      }, modeByName('faro'));
      const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: '¿por qué se cayó?' }));
      assert.match(said, /not up/i);
      assert.match(said, /\/pz start/, 'and where the way back up is');
      assert.doesNotMatch(said, /timed out/i, 'not the ssh error, which means nothing to the room');
    } finally {
      config.values.zomboidAddress = address;
    }
  });

  test('a door that answers nothing sayable does not go silent', async () => {
    const tools = zomboidTools(turnFor('kpo'), {
      keys: { read: '/dev/null', act: '/dev/null' },
      ask: async () => ({ ok: false, error: 'sin cupo' }),
    }, modeByName('faro'));
    const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: 'hola' }));
    assert.match(said, /could not get a clear answer/i);
  });
});

describe('a door that takes its time', () => {
  // A status question measured at 85 s on the real door; nothing in these
  // tests should take anywhere near that, so QUICK_ANSWER_MS is shrunk
  // through `deps.quickAnswerMs` rather than through the real constant.
  let configured;
  before(() => {
    configured = config.values.zomboidSsh;
    config.values.zomboidSsh = 'pz@10.0.0.1';
  });
  after(() => {
    config.values.zomboidSsh = configured;
  });

  const guild = {
    members: { cache: new Map([['kpo', { displayName: 'Vero', roles: { cache: [{ name: 'guardianes' }] } }]]), me: {} },
    channels: { cache: new Map() },
  };
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
  const turnFor = (askerId, g = guild) => ({ guildId: 'g1', guild: () => g, askerId, askerName: 'Vero' });
  const toolNamed = (tools, name) => tools.find((t) => t.name === name);
  const textOf = (result) => result.content[0].text;

  /** The next `late` event, or a rejection if none arrives in time. */
  function nextLate(timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        lateAnswers.off('late', onLate);
        reject(new Error('no late event arrived'));
      }, timeoutMs);
      const onLate = (payload) => {
        clearTimeout(timer);
        lateAnswers.off('late', onLate);
        resolve(payload);
      };
      lateAnswers.on('late', onLate);
    });
  }

  test('past the quick window: the turn is told to say "te aviso" and stop, and the answer surfaces later', async () => {
    const { posted, guild: g } = withChannel('sala-de-maquinas');
    const late = nextLate();
    const tools = zomboidTools(turnFor('kpo', g), {
      keys: { read: '/dev/null', act: '/dev/null' },
      quickAnswerMs: 10,
      ask: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        return {
          ok: true,
          spoken: 'Se cayó por un mod.',
          detail: '## Qué encontré\nEl mod BetterSorting no cargó.',
        };
      },
    }, modeByName('faro'));

    const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: '¿por qué se cayó?' }));
    assert.match(said, /still working|up to two minutes/i);
    assert.match(said, /stop/i);
    assert.doesNotMatch(said, /se cayó/i, 'the real answer is not in this turn at all');

    const payload = await late;
    assert.equal(payload.guildId, 'g1');
    assert.match(payload.spoken, /Se cayó por un mod/);
    assert.equal(posted.length, 1, 'written to the detail channel exactly like an on-time answer');
    assert.match(posted[0], /BetterSorting/);
  });

  test('inside the window: unchanged, no late event follows', async () => {
    let lateFired = false;
    const onLate = () => { lateFired = true; };
    lateAnswers.on('late', onLate);
    try {
      const tools = zomboidTools(turnFor('kpo'), {
        keys: { read: '/dev/null', act: '/dev/null' },
        quickAnswerMs: 500,
        ask: async () => ({ ok: true, spoken: 'Está arriba, hay tres jugando.' }),
      }, modeByName('faro'));
      const said = textOf(await toolNamed(tools, 'zomboid_ask').handler({ question: '¿anda?' }));
      assert.match(said, /Está arriba/);
      assert.doesNotMatch(said, /still working/i);
      // Give a settled ask's microtasks a turn, in case a late event were
      // (wrongly) queued anyway.
      await new Promise((resolve) => { setImmediate(resolve); });
    } finally {
      lateAnswers.off('late', onLate);
    }
    assert.equal(lateFired, false);
  });

  test('a late KeyRefused is a Spanish sentence, not the model instruction verbatim', async () => {
    // There is no model in the loop for a late answer to rewrite "say that
    // in one sentence" into something sayable — see askFailureSpoken. Said
    // verbatim, that instruction text would come out of the bot's mouth.
    const late = nextLate();
    const tools = zomboidTools(turnFor('kpo'), {
      keys: { read: '/dev/null', act: '/dev/null' },
      quickAnswerMs: 10,
      ask: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        throw new KeyRefused('the server did not accept this key');
      },
    }, modeByName('faro'));

    await toolNamed(tools, 'zomboid_ask').handler({ question: '¿anda?' });
    const payload = await late;
    assert.match(payload.spoken, /no aceptó mi llave/i);
    assert.doesNotMatch(payload.spoken, /say that|say so|say in one sentence/i, 'not the model-facing instruction');
    assert.doesNotMatch(payload.spoken, /255|publickey/i);
  });

  test('the same failure, acting: a different Spanish sentence, still no instruction text', async () => {
    const late = nextLate();
    const tools = zomboidTools(turnFor('kpo'), {
      keys: { read: '/dev/null', act: '/dev/null' },
      quickAnswerMs: 10,
      ask: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
        throw new KeyRefused('the server did not accept this key');
      },
    }, modeByName('faro'));

    await toolNamed(tools, 'zomboid_ask').handler({ question: 'reinicialo', act: true });
    const payload = await late;
    assert.match(payload.spoken, /no le dijeron que me deje cambiar/i);
    assert.doesNotMatch(payload.spoken, /say that|say so|say in one sentence/i);
  });
});

describe('the ssh call is explicit about which identity it uses', () => {
  test('IdentitiesOnly, no agent, public key only', () => {
    // Without these, `-i` is a suggestion: ssh offers every identity it can
    // find and the server takes the first that matches, so a read-only
    // question could authenticate with the key allowed to change things and
    // nobody would have decided it. Two keys only mean two permissions if
    // each call offers exactly one.
    const args = sshArgs({ destination: 'pz@host', keyPath: '/k/read', act: false });
    const pairs = args.join(' ');
    assert.match(pairs, /-i \/k\/read/);
    assert.match(pairs, /-o IdentitiesOnly=yes/);
    assert.match(pairs, /-o IdentityAgent=none/);
    assert.match(pairs, /-o PreferredAuthentications=publickey/);
    assert.match(pairs, /-o BatchMode=yes/);
    // The separator is not decoration: ssh keeps reading options after the
    // destination, so `ssh host --read` exits with a usage error before it
    // opens a socket. It cost one real knock on the door to find.
    assert.deepEqual(args.slice(-3), ['pz@host', '--', '--read']);
  });

  test('the mode travels too, for the day a key stops being pinned', () => {
    assert.deepEqual(sshArgs({ destination: 'pz@host', keyPath: '/k/act', act: true }).slice(-2), ['--', '--completo']);
  });

  test('one identity offered per call, and it is the one asked for', () => {
    for (const [key, act] of [['/k/read', false], ['/k/act', true]]) {
      const args = sshArgs({ destination: 'pz@host', keyPath: key, act });
      assert.equal(args.filter((a) => a === '-i').length, 1, 'exactly one identity');
      assert.equal(args[args.indexOf('-i') + 1], key);
    }
  });
});

describe('the three ways a door can fail to answer', () => {
  const guild = {
    members: { cache: new Map([['kpo', { displayName: 'Vero', roles: { cache: [{ name: 'guardianes' }] } }]]), me: {} },
    channels: { cache: new Map() },
  };
  const turn = { guildId: 'g1', guild: () => guild, askerId: 'kpo', askerName: 'Luc' };
  const askTool = (ask) =>
    zomboidTools(turn, { keys: { read: '/dev/null', act: '/dev/null' }, ask }, modeByName('faro')).find(
      (t) => t.name === 'zomboid_ask',
    );
  const textOf = (r) => r.content[0].text;

  let configured;
  before(() => {
    configured = { ssh: config.values.zomboidSsh, address: config.values.zomboidAddress };
    config.values.zomboidSsh = 'pz@10.0.0.1';
    config.values.zomboidAddress = '';
  });
  after(() => {
    config.values.zomboidSsh = configured.ssh;
    config.values.zomboidAddress = configured.address;
  });

  test('installed and refusing: it answers, and the refusal is the answer', async () => {
    // The door closed is not a failure — it replies in JSON, which is also the
    // best proof the key works and the path is whole.
    const said = textOf(
      await askTool(async () => ({ ok: false, spoken: 'La puerta está cerrada en el server.' })).handler({
        question: '¿por qué se cayó?',
      }),
    );
    assert.match(said, /puerta está cerrada/);
  });

  test('not installed yet: the key works and the script is missing', async () => {
    // Expected first, because the copy of the repo on that machine is synced
    // by hand: the key can be in place hours before the script is.
    const said = textOf(
      await askTool(async () => {
        throw new DoorMissing('exit 127');
      }).handler({ question: '¿por qué se cayó?' }),
    );
    assert.match(said, /not installed yet/i);
    assert.doesNotMatch(said, /127/, 'an exit code means nothing out loud');
  });

  test('no machine at all: normal, and somebody can fix it in two seconds', async () => {
    const said = textOf(
      await askTool(async () => {
        throw new Error('ssh: connect to host port 22: Connection timed out');
      }).handler({ question: '¿por qué se cayó?' }),
    );
    assert.match(said, /not up/i);
    assert.match(said, /\/pz start/);
  });
});

describe('a key the server will not take', () => {
  const guild = {
    members: { cache: new Map([['kpo', { displayName: 'Vero', roles: { cache: [{ name: 'guardianes' }] } }]]), me: {} },
    channels: { cache: new Map() },
  };
  const turn = { guildId: 'g1', guild: () => guild, askerId: 'kpo', askerName: 'Vero' };
  const textOf = (r) => r.content[0].text;
  const refusing = () =>
    zomboidTools(
      turn,
      {
        keys: { read: '/dev/null', act: '/dev/null' },
        ask: async () => {
          throw new KeyRefused('the server did not accept this key');
        },
      },
      modeByName('faro'),
    ).find((t) => t.name === 'zomboid_ask');

  let configured;
  before(() => {
    configured = { ssh: config.values.zomboidSsh, address: config.values.zomboidAddress };
    config.values.zomboidSsh = 'pz@10.0.0.1';
    config.values.zomboidAddress = '';
  });
  after(() => {
    config.values.zomboidSsh = configured.ssh;
    config.values.zomboidAddress = configured.address;
  });

  test('acting with a key nobody authorised says exactly that', async () => {
    // The expected state for a while, and by design: the act key exists here
    // long before anybody allows it there, because "it can only look" is the
    // default worth having. What the room must not hear is an exit code.
    const said = textOf(await refusing().handler({ question: 'reinicialo', act: true }));
    assert.match(said, /lets me look but has not been told to let me change/i);
    assert.doesNotMatch(said, /255|publickey/i);
  });

  test('and a refused read key is a different sentence', async () => {
    const said = textOf(await refusing().handler({ question: '¿anda?' }));
    assert.match(said, /did not accept my key/i);
  });
});
