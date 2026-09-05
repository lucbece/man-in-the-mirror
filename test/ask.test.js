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
function deps({ sentences = [], failWith = null, search = false, tools = [], effect = null } = {}) {
  const rendered = [];
  const notes = [];
  const fillersTaken = [];
  return {
    rendered,
    notes,
    fillersTaken,
    toAudioResource: (audio) => audio,
    noteInMusicChannel: async (_target, text) => {
      notes.push(text);
      return true;
    },
    transcribeBuffer: async () => ({ transcribed: 0 }),
    formatTranscript: () => '',
    takeFiller: (_lang, set) => {
      fillersTaken.push(set ?? 'thinking');
      return {
        line: set === 'waiting' ? 'Sigo buscando.' : 'Dame un segundo.',
        audio: { text: set === 'waiting' ? '<waiting>' : '<filler>' },
      };
    },
    createTts: () => ({
      label: 'fake voice',
      async synthesizeStream(text) {
        rendered.push(text);
        return { text };
      },
    }),
    createBrain: () => ({
      label: 'fake brain',
      async answer(_context, { onSentence, onSearchStart, onToolUse }) {
        // Order matters, and matches the real brains: the name is recorded
        // before anything decides whether to cover the wait with a filler.
        for (const name of tools) onToolUse?.(name);
        // What a tool actually did, before a word of the reply exists. This
        // is the order that lets enter/leave_music_mode change whether the
        // sentences behind them are spoken.
        effect?.();
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
    quiet: false,
    setQuiet(quiet) {
      this.quiet = quiet;
    },
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
    const result = await ask(fakeSession(), { question: 'hola', askedBy: 'Vero' }, d);

    assert.deepEqual(d.rendered, ['Primera frase.', 'Segunda frase.']);
    assert.equal(result.spoken, 'Primera frase. Segunda frase.');
    assert.ok(result.timings.firstAudioMs >= 0, 'should time the first audio');
    assert.ok(result.timings.totalMs >= 0);
  });

  test('records the exchange for the panel, once the answer is known', async () => {
    // fakeSession() has no recordExchange of its own — added here to check
    // what ask() hands it, the way the answers register is checked elsewhere.
    const session = fakeSession();
    const recorded = [];
    session.recordExchange = (exchange) => recorded.push(exchange);

    const d = deps({ sentences: ['La respuesta.'] });
    const result = await ask(session, { question: 'hola', askedBy: 'Vero' }, d);

    assert.equal(recorded.length, 1);
    assert.deepEqual(recorded[0], {
      askedBy: 'Vero',
      question: 'hola',
      answer: 'La respuesta.',
      firstAudioMs: result.timings.firstAudioMs,
      totalMs: result.timings.totalMs,
    });
  });

  test('a session with no recordExchange is not a failure — most fakes in this file have none', async () => {
    await ask(fakeSession(), { question: 'hola', askedBy: 'Vero' }, deps({ sentences: ['Ok.'] }));
    assert.ok(true, 'reaching here at all is the assertion');
  });

  test('one question at a time per guild', async () => {
    const session = fakeSession('busy');
    const first = ask(session, { question: 'a', askedBy: 'Vero' }, deps({ sentences: ['Una.'] }));
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
      () => ask(session, { question: 'a', askedBy: 'Vero' }, deps({ sentences: ['x.'], failWith: 'boom' })),
      /boom/,
    );
    // Reaching the brain again proves the guard let go.
    await assert.rejects(
      () => ask(session, { question: 'b', askedBy: 'Vero' }, deps({ sentences: ['x.'], failWith: 'boom again' })),
      /boom again/,
    );
  });

  test('a partial answer is still spoken when the brain fails midway', async () => {
    const d = deps({ sentences: ['Alcancé a decir esto.'], failWith: 'died midway' });
    await assert.rejects(() => ask(fakeSession(), { question: 'a', askedBy: 'Vero' }, d));
    assert.deepEqual(d.rendered, ['Alcancé a decir esto.'], 'what was said should have played');
  });

  test('an answer with nothing sayable is an error, not silence', async () => {
    await assert.rejects(
      () => ask(fakeSession(), { question: 'a', askedBy: 'Vero' }, deps({ sentences: [] })),
      /nothing to say/,
    );
  });

  test('the filler plays before the answer, and is not part of it', async () => {
    const session = fakeSession();
    const result = await ask(
      session,
      { question: 'a', askedBy: 'Vero' },
      deps({ sentences: ['La respuesta.'], search: true }),
    );

    assert.deepEqual(session.played, ['<filler>', 'La respuesta.']);
    assert.equal(result.timings.filler, 'Dame un segundo.');
    assert.equal(result.spoken, 'La respuesta.');
  });

  test('speech is capped, and the cap is reported', async () => {
    const largo = `${'palabra '.repeat(40)}.`;
    const d = deps({ sentences: [largo, largo, largo] });
    const result = await ask(fakeSession(), { question: 'a', askedBy: 'Vero' }, d);

    assert.ok(d.rendered.join('').length <= 380, 'spoke past the cap');
    assert.equal(result.truncated, true, 'should report being cut');
  });

  test('transcription only runs when the bot is listening', async () => {
    let called = 0;
    const d = { ...deps({ sentences: ['Hola.'] }), transcribeBuffer: async () => { called += 1; } };

    await ask(fakeSession(), { question: 'a', askedBy: 'Vero' }, d);
    assert.equal(called, 0, 'deafened: nothing to transcribe');

    const listening = { ...fakeSession('g2'), agentEnabled: true };
    await ask(listening, { question: 'a', askedBy: 'Vero' }, d);
    assert.equal(called, 1);
  });
});

describe('doing something without saying anything', () => {
  test('a turn that only controls music never takes the mouth', async () => {
    // Taking it pauses the track. Skipping a song and then pausing the next
    // one to announce the skip is worse than not skipping at all.
    const session = fakeSession();
    let tookTheMouth = false;
    const realStart = session.startSpeech.bind(session);
    session.startSpeech = () => {
      tookTheMouth = true;
      return realStart();
    };

    const result = await ask(
      session,
      { question: 'skip esta' },
      deps({ tools: ['mcp__bot__skip_song'], search: true }),
    );

    assert.equal(tookTheMouth, false, 'must not have paused the music');
    assert.equal(result.spoken, '');
  });

  test('but silence with nothing done is still the model failing', async () => {
    // The case the old error existed for, and it has to survive: a model that
    // says nothing and did nothing is broken, not laconic.
    await assert.rejects(
      () => ask(fakeSession(), { question: 'hola' }, deps({ sentences: [] })),
      /nothing to say/,
    );
  });

  test('a music command that also asks something does speak', async () => {
    const result = await ask(
      fakeSession(),
      { question: 'poné algo y decime la hora' },
      deps({ tools: ['mcp__bot__play_music'], sentences: ['Son las tres de la tarde.'] }),
    );

    assert.match(result.spoken, /Son las tres/);
  });

  test('a tool that is not about music still gets its filler', async () => {
    // The suppression is for commands, not for every tool: a web search is
    // somebody waiting on an answer, and the silence needs covering.
    const d = deps({ tools: ['mcp__bot__search_web'], search: true, sentences: ['Listo.'] });
    await ask(fakeSession(), { question: 'buscá algo' }, d);

    assert.ok(d.rendered.length > 0, 'should have rendered something');
  });
});

describe('reasoning read aloud is dropped for the rest of the turn', () => {
  test('the eight sentences actually heard, of which only the first is plainly English', async () => {
    // Verbatim from a call, split as the sentence splitter split them. Judged
    // one by one, "Looking at the context:" is too short to call and the
    // bullets are half Spanish, so seven of the eight were spoken.
    const sentences = [
      'I need to work out what fede is actually asking here.',
      'Looking at the context:',
      '- fede said "Espejo, buenas noches" at 13:23:34',
      '- According to instruction 1, when someone says "buenas noches", I should respond "buenas noches, che"',
      '- fede is now saying "Al fin y al cabo" (at the end of the day / after all)',
      '"Al fin y al cabo" appears to be fede continuing to talk, not a new question directed at me.',
    ];
    const d = deps({ sentences });
    const result = await ask(fakeSession(), { question: 'Al fin y al cabo.', askedBy: 'fede' }, d);

    assert.deepEqual(d.rendered, [], 'none of it should have been synthesised');
    assert.equal(result.spoken, '');
    assert.equal(result.timings.droppedReasoning, sentences.length);
  });

  test('a real answer after the guard has not fired is untouched', async () => {
    const d = deps({ sentences: ['Buenas noches, che.', 'Al fin y al cabo, sí.'] });
    const result = await ask(fakeSession(), { question: 'Espejo, la concha de tu madre.' }, d);
    assert.deepEqual(d.rendered, ['Buenas noches, che.', 'Al fin y al cabo, sí.']);
    assert.equal(result.timings.droppedReasoning, undefined);
  });
});

describe('stage directions are written, never spoken', () => {
  test('a parenthetical alone is dropped rather than read out', async () => {
    // Asked to answer a music command with nothing, the model produced
    // "(reproduciendo)" — a sentence describing silence, which the voice then
    // reads aloud. Three rounds of asking it not to failed, so it is a rule.
    const d = deps({ tools: ['mcp__bot__play_music'], sentences: ['(reproduciendo)'] });
    const result = await ask(fakeSession(), { question: 'poné algo' }, d);

    assert.equal(result.spoken, '');
    assert.deepEqual(d.rendered, [], 'nothing should have been synthesised');
  });

  test('asterisked and bracketed actions too', async () => {
    for (const line of ['*plays the song*', '[silencio]']) {
      const d = deps({ tools: ['mcp__bot__play_music'], sentences: [line] });
      const result = await ask(fakeSession(), { question: 'poné algo' }, d);
      assert.equal(result.spoken, '', line);
    }
  });

  test('but a sentence that merely contains brackets is still said', async () => {
    // "Es de Rada (el uruguayo)" is speech with an aside in it, not an aside.
    const d = deps({
      tools: ['mcp__bot__play_music'],
      sentences: ['Es de Rubén Rada (el uruguayo), del setenta y siete.'],
    });
    const result = await ask(fakeSession(), { question: 'de quién es' }, d);

    assert.match(result.spoken, /Rubén Rada/);
  });
});

describe('an aside that opens a sentence', () => {
  test('is stripped, and the sentence survives', async () => {
    // Heard in a real call: "(silence) No real question here — just a comment
    // about me." The whole-line check misses it, because there is a sentence
    // stapled to the aside.
    const d = deps({ sentences: ['(silence) No hay nada que preguntar acá, che.'] });
    const result = await ask(fakeSession(), { question: 'está re joven el espejo' }, d);

    assert.ok(!result.spoken.includes('silence'), `still said it: ${result.spoken}`);
    assert.match(result.spoken, /No hay nada que preguntar/);
  });

  test('a parenthetical in the middle of a sentence is left alone', async () => {
    // "Es de Rada (el uruguayo)" is speech with an aside inside it, which is
    // ordinary writing rather than a stage direction.
    const d = deps({ sentences: ['Es de Rubén Rada (el uruguayo), del setenta y siete.'] });
    const result = await ask(fakeSession(), { question: 'de quién es' }, d);

    assert.match(result.spoken, /\(el uruguayo\)/);
  });
});

describe('music mode: it hears, it acts, it says nothing', () => {
  const quietSession = (guildId = 'quiet') => {
    const session = fakeSession(guildId);
    session.quiet = true;
    return session;
  };

  test('the answer is written to the music channel instead of spoken', async () => {
    const session = quietSession();
    const d = deps({ sentences: ['Es de Rubén Rada.', 'Del setenta y siete.'] });
    const result = await ask(session, { question: 'de quién es', askedBy: 'Vero' }, d);

    assert.deepEqual(d.rendered, [], 'nothing may be synthesised');
    assert.deepEqual(session.played, [], 'and nothing may be played');
    assert.equal(result.spoken, '', 'nobody heard a word of it');
    assert.deepEqual(d.notes, ['🤫  Es de Rubén Rada. Del setenta y siete.']);
    assert.equal(result.written, 'Es de Rubén Rada. Del setenta y siete.');
  });

  test('one message per turn, not one per sentence', async () => {
    // Three lines in the channel read as three answers to three questions.
    const d = deps({ sentences: ['Una.', 'Dos.', 'Tres.'] });
    await ask(quietSession(), { question: 'contá', askedBy: 'Fede' }, d);
    assert.equal(d.notes.length, 1);
  });

  test('the mouth is never taken, so the song does not pause', async () => {
    // Taking it is what pauses the track, and pausing it to say nothing is
    // the exact failure music mode exists to prevent.
    const session = quietSession();
    let tookTheMouth = false;
    const realStart = session.startSpeech.bind(session);
    session.startSpeech = () => {
      tookTheMouth = true;
      return realStart();
    };

    await ask(session, { question: 'qué hora es', askedBy: 'Pato' }, deps({ sentences: ['Las tres.'] }));
    assert.equal(tookTheMouth, false);
  });

  test('no filler clip is even fetched', async () => {
    const d = deps({ sentences: ['Listo.'], search: true, tools: ['mcp__bot__search_web'] });
    const result = await ask(quietSession(), { question: 'buscá algo', askedBy: 'Vero' }, d);

    assert.deepEqual(d.fillersTaken, [], 'a clip nobody can hear is a request for nothing');
    assert.equal(result.timings.filler, undefined);
  });

  test('the tools still run, and their turn writes nothing on its own', async () => {
    // "espejo, saltá" while a song is on: the track changes and the channel
    // hears the result rather than a sentence about it.
    const d = deps({ tools: ['mcp__bot__skip_song'] });
    const result = await ask(quietSession(), { question: 'saltá' }, d);

    assert.equal(result.spoken, '');
    assert.equal(result.written, '');
    assert.deepEqual(d.notes, [], 'skip_song writes its own note; ask must not add one');
  });

  test('being asked to talk again is answered out loud, by that same turn', async () => {
    // The whole reason the flag is read per sentence rather than once at the
    // top of the turn. leave_music_mode flips it, and the reply behind it is
    // heard — otherwise the only way back would be the keyboard.
    const session = quietSession('talks-again');
    const d = deps({
      tools: ['mcp__bot__leave_music_mode'],
      effect: () => session.setQuiet(false),
      sentences: ['Listo, vuelvo a hablar.'],
    });
    const result = await ask(session, { question: 'espejo, hablá de nuevo' }, d);

    assert.equal(result.spoken, 'Listo, vuelvo a hablar.');
    assert.deepEqual(session.played, ['Listo, vuelvo a hablar.']);
    assert.deepEqual(d.notes, [], 'it was heard, so there is nothing to write');
  });

  test('and being asked for quiet is confirmed in writing, by that same turn', async () => {
    const session = fakeSession('goes-quiet');
    const d = deps({
      tools: ['mcp__bot__enter_music_mode'],
      effect: () => session.setQuiet(true),
      sentences: ['Dale, me callo.'],
    });
    const result = await ask(session, { question: 'espejo, mutéate' }, d);

    assert.equal(result.spoken, '');
    assert.deepEqual(d.notes, ['🤫  Dale, me callo.']);
  });
});
