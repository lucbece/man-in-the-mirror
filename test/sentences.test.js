import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { SentenceSplitter } from '../src/agent/sentences.js';

/** Feed text one character at a time, the way a token stream actually arrives. */
function drip(text, options) {
  const splitter = new SentenceSplitter(options);
  const chunks = [];
  for (const char of text) chunks.push(...splitter.push(char));
  const tail = splitter.flush();
  if (tail) chunks.push(tail);
  return chunks;
}

describe('SentenceSplitter', () => {
  test('splits on sentence ends', () => {
    assert.deepEqual(
      drip('Yo iría por el sábado, así lo disfrutamos. El jueves da lluvia.'),
      ['Yo iría por el sábado, así lo disfrutamos.', 'El jueves da lluvia.'],
    );
  });

  test('never splits a decimal', () => {
    // "dos punto" … "cinco por ciento" is a stutter nobody forgives.
    assert.deepEqual(
      drip('La inflación fue de 2.5 por ciento el mes pasado, bastante alta.'),
      ['La inflación fue de 2.5 por ciento el mes pasado, bastante alta.'],
    );
  });

  test('never splits an abbreviation or an initial', () => {
    assert.deepEqual(
      drip('Hablé con el Sr. García sobre el tema y quedamos en algo.'),
      ['Hablé con el Sr. García sobre el tema y quedamos en algo.'],
    );
    assert.deepEqual(
      drip('El libro es de J. R. Tolkien y está muy bien escrito.'),
      ['El libro es de J. R. Tolkien y está muy bien escrito.'],
    );
  });

  test('keeps a very short opener attached to what follows', () => {
    // "Sí." on its own is a bark and a pause. It should ride along.
    const chunks = drip('Sí. Yo lo movería al sábado sin pensarlo demasiado.');
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].startsWith('Sí.'));
  });

  test('carries closing punctuation with the sentence', () => {
    assert.deepEqual(
      drip('Le pregunté "¿vas a venir el sábado?" y no me contestó nada.'),
      ['Le pregunté "¿vas a venir el sábado?" y no me contestó nada.'],
    );
  });

  test('breaks at a comma when a clause runs on past all reason', () => {
    // Without this a run-on sentence would hold the whole reply hostage,
    // which defeats the point of speaking early.
    const runOn = `${'palabra '.repeat(20)}, y despues sigue todavia un poco mas`;
    const chunks = drip(runOn, { maxChunk: 80 });
    assert.ok(chunks.length > 1, 'should have been broken up');
    assert.ok(chunks[0].length <= 80);
  });

  test('flush returns the tail that never got a full stop', () => {
    const splitter = new SentenceSplitter();
    assert.deepEqual(splitter.push('Primera oración completa acá. Y esto queda colgado'), [
      'Primera oración completa acá.',
    ]);
    assert.equal(splitter.flush(), 'Y esto queda colgado');
    assert.equal(splitter.flush(), '', 'flush empties the buffer');
  });

  test('the whole text survives being cut up, whatever the chunking', () => {
    // The one property that must always hold: nothing is dropped or doubled.
    const text =
      'Mirá, yo diría que conviene esperar. El pronóstico da lluvia para el jueves. ' +
      'Si podés moverlo al sábado te ahorrás el problema, aunque fijate vos.';
    assert.equal(drip(text).join(' '), text.trim());
  });

  test('a delta landing mid-word does not create a boundary', () => {
    // Deltas arrive at arbitrary offsets; a chunk must never be emitted on
    // punctuation that the next delta turns out to continue.
    const splitter = new SentenceSplitter();
    assert.deepEqual(splitter.push('El total fue de 3'), []);
    assert.deepEqual(splitter.push('.'), []);
    assert.deepEqual(splitter.push('7 por ciento este mes, bastante.'), []);
    assert.equal(splitter.flush(), 'El total fue de 3.7 por ciento este mes, bastante.');
  });
});
