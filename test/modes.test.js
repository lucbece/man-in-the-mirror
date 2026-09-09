import assert from 'node:assert/strict';
import test, { beforeEach, describe } from 'node:test';

import { MODES, describeModes, findMode, modeByName, modePrompt } from '../src/agent/modes.js';
import { botTools } from '../src/agent/tools/index.js';
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
