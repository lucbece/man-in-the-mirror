import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ask, AgentBusyError } from '../src/agent/index.js';

/**
 * The orchestrator with its collaborators replaced.
 *
 * `ask()` is where the brain, the synthesiser, the filler clips and the speech
 * queue meet, and it had no coverage at all — which is where two of the three
 * defects found by reading the code were living. These run the whole round
 * trip without a network, a Discord connection or an API key.
 */
function deps({ sentences = [], failWith = null, search = false } = {}) {
  const rendered = [];
  return {
    rendered,
    toAudioResource: (audio) => audio,
    transcribeBuffer: async () => ({ transcribed: 0 }),
    formatTranscript: () => '',
    takeFiller: (_lang, set) => ({
      line: set === 'waiting' ? 'Sigo buscando.' : 'Dame un segundo.',
      audio: { text: set === 'waiting' ? '<waiting>' : '<filler>' },
    }),
    createTts: () => ({
      label: 'fake voice',
      async synthesizeStream(text) {
        rendered.push(text);
        return { text };
      },
    }),
    createBrain: () => ({
      label: 'fake brain',
      async answer(_context, { onSentence, onSearchStart }) {
        if (search) onSearchStart?.();
        for (const s of sentences) onSentence(s);
        if (failWith) throw new Error(failWith);
        return sentences.join(' ');
      },
    }),
  };
}

/** A speech queue that plays instantly, so an answer completes in one tick. */
function fakeSession(guildId = 'g1') {
  const played = [];
  return {
    guildId,
    agentEnabled: false,
    played,
    receiver: { buffer: { recent: () => [] } },
    startSpeech() {
      const spoken = [];
      let resolve;
      const finished = new Promise((r) => {
        resolve = r;
      });
      return {
        spoken,
        finished,
        push(resource, text) {
          played.push(resource.text);
          if (text) spoken.push(text);
        },
        end: () => resolve({ cancelled: false }),
        cancel: () => resolve({ cancelled: true }),
      };
    },
  };
}

describe('ask()', () => {
  test('speaks each sentence and reports what was said', async () => {
    const d = deps({ sentences: ['Primera frase.', 'Segunda frase.'] });
    const result = await ask(fakeSession(), { question: 'hola', askedBy: 'Luc' }, d);

    assert.deepEqual(d.rendered, ['Primera frase.', 'Segunda frase.']);
    assert.equal(result.spoken, 'Primera frase. Segunda frase.');
    assert.ok(result.timings.firstAudioMs >= 0, 'should time the first audio');
    assert.ok(result.timings.totalMs >= 0);
  });

  test('one question at a time per guild', async () => {
    const session = fakeSession('busy');
    const first = ask(session, { question: 'a', askedBy: 'Luc' }, deps({ sentences: ['Una.'] }));
    await assert.rejects(
      () => ask(session, { question: 'b', askedBy: 'Marco' }, deps({ sentences: ['Dos.'] })),
      AgentBusyError,
    );
    await first;
  });

  test('the guard is released even when the brain throws', async () => {
    // Otherwise one failure silences that guild until the process restarts —
    // the same shape as the playback bug, from a different direction.
    const session = fakeSession('recovers');
    await assert.rejects(
      () => ask(session, { question: 'a', askedBy: 'Luc' }, deps({ sentences: ['x.'], failWith: 'boom' })),
      /boom/,
    );
    // Reaching the brain again proves the guard let go.
    await assert.rejects(
      () => ask(session, { question: 'b', askedBy: 'Luc' }, deps({ sentences: ['x.'], failWith: 'boom again' })),
      /boom again/,
    );
  });

  test('a partial answer is still spoken when the brain fails midway', async () => {
    const d = deps({ sentences: ['Alcancé a decir esto.'], failWith: 'died midway' });
    await assert.rejects(() => ask(fakeSession(), { question: 'a', askedBy: 'Luc' }, d));
    assert.deepEqual(d.rendered, ['Alcancé a decir esto.'], 'what was said should have played');
  });

  test('an answer with nothing sayable is an error, not silence', async () => {
    await assert.rejects(
      () => ask(fakeSession(), { question: 'a', askedBy: 'Luc' }, deps({ sentences: [] })),
      /nothing to say/,
    );
  });

  test('the filler plays before the answer, and is not part of it', async () => {
    const session = fakeSession();
    const result = await ask(
      session,
      { question: 'a', askedBy: 'Luc' },
      deps({ sentences: ['La respuesta.'], search: true }),
    );

    assert.deepEqual(session.played, ['<filler>', 'La respuesta.']);
    assert.equal(result.timings.filler, 'Dame un segundo.');
    assert.equal(result.spoken, 'La respuesta.');
  });

  test('speech is capped, and the cap is reported', async () => {
    const largo = `${'palabra '.repeat(40)}.`;
    const d = deps({ sentences: [largo, largo, largo] });
    const result = await ask(fakeSession(), { question: 'a', askedBy: 'Luc' }, d);

    assert.ok(d.rendered.join('').length <= 380, 'spoke past the cap');
    assert.equal(result.truncated, true, 'should report being cut');
  });

  test('transcription only runs when the bot is listening', async () => {
    let called = 0;
    const d = { ...deps({ sentences: ['Hola.'] }), transcribeBuffer: async () => { called += 1; } };

    await ask(fakeSession(), { question: 'a', askedBy: 'Luc' }, d);
    assert.equal(called, 0, 'deafened: nothing to transcribe');

    const listening = { ...fakeSession('g2'), agentEnabled: true };
    await ask(listening, { question: 'a', askedBy: 'Luc' }, d);
    assert.equal(called, 1);
  });
});
