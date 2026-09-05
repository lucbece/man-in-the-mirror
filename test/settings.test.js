import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  SETTINGS,
  SettingError,
  describeSettings,
  findSetting,
  planChange,
  settingKeys,
  settingsSnapshot,
} from '../src/agent/settings.js';

/** A config as the tools see it: only the keys the registry declares. */
function values(overrides = {}) {
  return {
    ttsProvider: 'openai',
    ttsVoice: 'onyx',
    ttsLocalVoice: 'es_ES-davefx-medium',
    sttProvider: 'openai',
    sttLocalModel: 'ggml-base',
    brainKind: 'agent',
    brainModel: '',
    webSearch: true,
    agentMaxTurns: 8,
    bufferSeconds: 90,
    wakeEnabled: true,
    agentEnabled: true,
    eagerTranscription: true,
    agentDirectories: '',
    ...overrides,
  };
}

describe('what the voice can reach', () => {
  test('no secret is in the registry, and none can be read through it', () => {
    // This is the property the whole module exists for. The config holds the
    // Discord token and two API keys next to the choice of voice; they are out
    // of reach because they are absent here, not because something downstream
    // filters them.
    const secrets = ['token', 'openaiApiKey', 'anthropicApiKey', 'guildId', 'webPort'];
    for (const key of secrets) assert.ok(!settingKeys().includes(key), `${key} must not be reachable`);

    const snapshot = settingsSnapshot((key) => {
      assert.ok(!secrets.includes(key), `must not even ask for ${key}`);
      return values()[key];
    });
    assert.deepEqual(Object.keys(snapshot).sort(), settingKeys().sort());
  });

  test('describing never emits a value it cannot also parse back', () => {
    // A setting people can hear but not change is a dead end in conversation.
    const text = describeSettings(values());
    for (const setting of SETTINGS) {
      assert.match(text, new RegExp(setting.name.replace(' ', '\\s')), `${setting.name} missing`);
    }
    assert.ok(!/sk-|discord|token/i.test(text), 'no secret-shaped text');
  });
});

describe('finding a setting by whatever it was called', () => {
  test('exact names, aliases and both languages', () => {
    assert.equal(findSetting('speaking').key, 'ttsProvider');
    assert.equal(findSetting('tts').key, 'ttsProvider');
    assert.equal(findSetting('transcripcion').key, 'sttProvider');
    assert.equal(findSetting('cerebro').key, 'brainKind');
  });

  test('the longer name wins, so "hearing model" is not "hearing"', () => {
    assert.equal(findSetting('hearing model').key, 'sttLocalModel');
    assert.equal(findSetting('hearing').key, 'sttProvider');
  });

  test('refuses an unknown one by listing the real names', () => {
    assert.throws(() => findSetting('anthropic key'), SettingError);
    assert.throws(() => findSetting('anthropic key'), /speaking, voice, hearing/);
  });
});

describe('changing one', () => {
  test('the asked-for case: speaking, from OpenAI to this machine', () => {
    const plan = planChange(values(), 'speaking', 'local');
    assert.deepEqual(plan.patch, { ttsProvider: 'local' });
    assert.equal(plan.describeBefore, 'OpenAI (API)');
    assert.match(plan.describeAfter, /Piper/);
    assert.ok(!plan.setting.session, 'the voice does not restart the session');
  });

  test('understands how people actually say it', () => {
    for (const said of ['en esta maquina', 'this machine', 'piper', 'offline']) {
      assert.equal(planChange(values(), 'speaking', said).after, 'local', said);
    }
    for (const said of ['la API', 'openai', 'the cloud']) {
      assert.equal(planChange(values(), 'hearing', said).after, 'openai', said);
    }
    for (const said of ['off', 'no', 'apagalo', 'desactivado']) {
      assert.equal(planChange(values(), 'web search', said).after, false, said);
    }
  });

  test('the voice setting follows the provider in use', () => {
    // Setting `ttsVoice` while Piper is speaking would be accepted, stored,
    // and never heard by anyone.
    assert.equal(planChange(values(), 'voice', 'nova').key, 'ttsVoice');
    assert.equal(planChange(values({ ttsProvider: 'local' }), 'voice', 'daniela').key, 'ttsLocalVoice');
    assert.equal(
      planChange(values({ ttsProvider: 'local' }), 'voice', 'daniela').after,
      'es_AR-daniela-high',
    );
    // And a voice from the other provider is refused rather than stored.
    assert.throws(() => planChange(values({ ttsProvider: 'local' }), 'voice', 'nova'), /Piper voices/);
  });

  test('a refusal names the options, because it is read out loud', () => {
    assert.throws(() => planChange(values(), 'speaking', 'elevenlabs'), /openai, local/);
    assert.throws(() => planChange(values(), 'web search', 'quizás'), /yes or a no/);
    assert.throws(() => planChange(values(), 'tool rounds', '90'), /outside 1–25/);
  });

  test('numbers survive being spoken with their unit', () => {
    assert.equal(planChange(values(), 'memory', '120 seconds').after, 120);
    assert.equal(planChange(values(), 'tool rounds', '12 rondas').after, 12);
    assert.throws(() => planChange(values(), 'memory', 'un rato'), /isn't a number/);
  });

  test('a model name is taken as written, and a sentence is not', () => {
    assert.equal(planChange(values(), 'model', 'claude-haiku-4-5').after, 'claude-haiku-4-5');
    assert.equal(planChange(values(), 'model', 'por defecto').after, '');
    // Half-heard speech arriving where an identifier belongs would break every
    // answer until someone opened the panel.
    assert.throws(() => planChange(values(), 'model', 'el mejor que tengas, dale'), /model name/);
  });

  test('reports no-ops instead of writing them', () => {
    const plan = planChange(values(), 'speaking', 'openai');
    assert.equal(plan.unchanged, true);
  });

  test('flags the changes that cost the conversation its memory', () => {
    assert.equal(planChange(values(), 'model', 'claude-opus-5').setting.session, true);
    assert.equal(planChange(values(), 'thinking', 'chat').setting.session, true);
    assert.equal(planChange(values(), 'memory', '120').setting.session, undefined);
  });

  test('folders are the one entry gated on permission, and need full paths', () => {
    // It decides what a connected filesystem server may read, which is a
    // security boundary rather than a preference.
    assert.equal(findSetting('folders').ownerOnly, true);
    // Folders, and the three that set the bill for every later answer.
    assert.deepEqual(SETTINGS.filter((s) => s.ownerOnly).map((s) => s.key).sort(), ['agentDirectories', 'agentMaxTurns', 'brainModel', 'fastModel']);
    assert.equal(planChange(values(), 'folders', '/home/vero/notes').after, '/home/vero/notes');
    assert.equal(planChange(values(), 'folders', 'C:\\Users\\vero\\notes').after, 'C:\\Users\\vero\\notes');
    assert.throws(() => planChange(values(), 'folders', 'la carpeta de documentos'), /full path/);
  });
});
