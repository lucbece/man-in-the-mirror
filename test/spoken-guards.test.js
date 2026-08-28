import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  isStageDirection,
  looksLikeLeakedReasoning,
  withoutOpeningAside,
} from '../src/agent/spoken-guards.js';

/**
 * Every case here was heard out loud in a real call before it was a test.
 * That is the only reason these guards exist: each one was first attempted as
 * a line in the prompt, and each one came back.
 */

describe('asides written for a reader that has no reader', () => {
  test('a line that is only a stage direction is not spoken', () => {
    assert.equal(isStageDirection('(reproduciendo música)'), true);
    assert.equal(isStageDirection('*plays music*'), true);
    assert.equal(isStageDirection('[silencio]'), true);
  });

  test('an ordinary sentence is', () => {
    assert.equal(isStageDirection('Puse el disco.'), false);
    assert.equal(isStageDirection('Es de Rada (el uruguayo).'), false);
  });

  test('an aside with a sentence stapled to it loses only the aside', () => {
    // Heard verbatim: "(silence) No real question here".
    assert.equal(withoutOpeningAside('(silence) Dale, te escucho.'), 'Dale, te escucho.');
  });

  test('one in the middle belongs to the sentence and stays', () => {
    const said = 'Es de Rada (el uruguayo).';
    assert.equal(withoutOpeningAside(said), said);
  });
});

describe('reasoning read out loud', () => {
  const asked = 'espejo, che, escuchá lo que dijo luc';

  test('the three that were actually heard in the channel', () => {
    for (const leaked of [
      'I don\'t see an actual question here — luc just said "4. Mueh", which looks like they are still talking to ran, or testing the mic.',
      'I hear the setup to a joke, but Dr Luchi has not finished asking yet — they are mid-sentence.',
      'Noco just said "wtf mi horror". That is not really a question directed at me, so there is nothing to answer.',
    ]) {
      assert.equal(looksLikeLeakedReasoning(leaked, asked), true, leaked.slice(0, 40));
    }
  });

  test('an answer in the language it was asked in survives', () => {
    for (const fine of [
      'Jaja, dale. Que entren nomás.',
      'No sé quién es, che. ¿De dónde la conocés vos?',
      'Está sonando Californication, del disco que se llama igual.',
    ]) {
      assert.equal(looksLikeLeakedReasoning(fine, asked), false, fine);
    }
  });

  test('English inside a Spanish sentence is not English', () => {
    // Titles and band names are half the music answers this thing gives, and
    // a rule that ate them would be worse than the bug.
    const said = 'Puse Every You Every Me de Placebo, del disco Without You I am Nothing.';
    assert.equal(looksLikeLeakedReasoning(said, asked), false);
  });

  test('too short to judge is left alone', () => {
    // "Dale." carries no evidence either way, and dropping it costs an answer.
    assert.equal(looksLikeLeakedReasoning('Dale.', asked), false);
    assert.equal(looksLikeLeakedReasoning('Yes, sure thing.', asked), false);
  });

  test('a question asked in English gets an English answer, untouched', () => {
    // The signal is the mismatch, not the language. Policing English here
    // would break the bot for anyone who speaks it.
    const said = 'I don\'t think there is an actual question in what they said.';
    assert.equal(looksLikeLeakedReasoning(said, 'mirror, what do you think about that?'), false);
  });
});
