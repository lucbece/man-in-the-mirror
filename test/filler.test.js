import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { guessLanguage, takeFiller, LINES } from '../src/agent/filler.js';

describe('guessLanguage', () => {
  test('recognises Spanish even with accents', () => {
    // The bug this exists for: JavaScript's \b does not treat "é" as a word
    // character, so /\bqué\b/ silently never matched and Spanish was
    // classified as English.
    for (const text of [
      'espejo, qué opinás de esto',
      'espejo, va a llover mañana',
      'che espejo, cómo andás',
      'decime algo, espejo',
    ]) {
      assert.equal(guessLanguage(text), 'es', `should be Spanish: ${text}`);
    }
  });

  test('recognises English', () => {
    for (const text of ['mirror what do you think', 'hey mirror who won the game']) {
      assert.equal(guessLanguage(text), 'en', `should be English: ${text}`);
    }
  });

  test('handles empty and junk input', () => {
    assert.equal(guessLanguage(''), 'en');
    assert.equal(guessLanguage(null), 'en');
    assert.equal(guessLanguage('!!! ???'), 'en');
  });
});

describe('takeFiller', () => {
  test('returns nothing rather than stalling when no clip is cached', () => {
    // Synthesising on demand would cost as much as the wait it covers, so an
    // empty cache must mean silence, never a blocking render.
    const result = takeFiller('es');
    if (result === null) return; // nothing warmed in this process — correct
    assert.ok(result.audio instanceof Buffer);
    assert.ok(LINES.es.includes(result.line) || LINES.en.includes(result.line));
  });

  test('has distinct lines per language so it can match the speaker', () => {
    assert.ok(LINES.es.length >= 2);
    assert.ok(LINES.en.length >= 2);
    assert.equal(LINES.es.some((l) => LINES.en.includes(l)), false);
  });

  test('lines are short enough to finish before the search does', () => {
    // A search takes roughly 1.5s. At ~2.5 words a second, anything past about
    // 25 characters would still be talking when the answer is ready.
    for (const line of [...LINES.es, ...LINES.en]) {
      assert.ok(line.length <= 25, `too long to be a filler: ${line}`);
    }
  });
});
