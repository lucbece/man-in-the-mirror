import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { detectAddress } from '../src/agent/wake.js';

const NAMES = 'mirror, espejo';

describe('detectAddress', () => {
  test('notices its name wherever it falls in the sentence', () => {
    // Why this isn't prefix matching: people put the name at the front, the
    // middle, or the end, and all three mean the same thing. Slicing at the
    // name would leave "what do you reckon, mirror?" with an empty question.
    for (const heard of [
      'mirror what do you think',
      'che mirror qué opinás de esto',
      'what do you reckon, mirror?',
      'so anyway mirror who is right here',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, true, `missed: ${heard}`);
    }
  });

  test('answers to any of its names', () => {
    assert.equal(detectAddress('espejo cuéntame algo', NAMES).name, 'espejo');
    assert.equal(detectAddress('mirror tell me something', NAMES).name, 'mirror');
  });

  test('tolerates the misrecognition speech-to-text actually produces', () => {
    for (const heard of ['hey mirrow what now', 'el mirror estás escuchando', 'Mirror!']) {
      assert.equal(detectAddress(heard, NAMES).matched, true, `missed: ${heard}`);
    }
  });

  test('ignores casing, punctuation and accents', () => {
    assert.equal(detectAddress('ESPEJO, ¿qué opinás?', NAMES).matched, true);
  });

  test('a name in the spoken language survives transcription', () => {
    // From a real session: "hey mirror" said inside a Spanish sentence came
    // back as "Amy". Nothing fuzzy can rescue that — but a Spanish name in
    // Spanish speech is written down correctly.
    const asHeard = 'Bueno, mira quién volvió acá. Amy, cuáles son las probabilidades';
    assert.equal(detectAddress(asHeard, 'mirror').matched, false);
    assert.equal(detectAddress('Espejo, cuáles son las probabilidades', NAMES).matched, true);
  });

  test('does not fire on ordinary conversation', () => {
    for (const heard of [
      'creo que es una cuestión de formato',
      'como que openai me devuelve un mp3',
      'the servers were down all weekend',
      'mira quién volvió acá',
      'mierda',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, false, `false positive: ${heard}`);
    }
  });

  test('short names must land exactly, since fuzzy matching would overfire', () => {
    assert.equal(detectAddress('mj play something', 'mj').matched, true);
    // "my" is one edit away from "mj" and appears constantly in speech.
    assert.equal(detectAddress('my turn now', 'mj').matched, false);
  });

  test('reports where the name appeared', () => {
    assert.equal(detectAddress('mirror hello', NAMES).at, 0);
    assert.equal(detectAddress('so anyway mirror hello', NAMES).at, 2);
  });

  test('handles empty and malformed input without throwing', () => {
    assert.equal(detectAddress('', NAMES).matched, false);
    assert.equal(detectAddress('mirror', '').matched, false);
    assert.equal(detectAddress('mirror', ' , , ').matched, false);
    assert.equal(detectAddress('mirror hola', 'mirror,,').matched, true);
  });
});
