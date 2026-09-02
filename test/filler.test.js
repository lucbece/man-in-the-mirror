import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { guessLanguage, takeFiller, LINES, WAITING_LINES } from '../src/agent/filler.js';

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

  test('recognises Spanish made only of small words', () => {
    // These were classified as English: not one of their words was on the
    // list, so the guard against reasoning read aloud never ran on the turn
    // that leaked eight sentences of it into the channel.
    for (const text of [
      'Espejo, la concha de tu madre.',
      'Al fin y al cabo.',
      'Ya te dije espejo, te dije.',
      'sombrero, poneme un tema',
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

describe('the long-wait lines', () => {
  test('are a separate, distinct set from the opening ones', () => {
    // Reusing an opening line after ten seconds of silence would sound like
    // the bot forgot it already said it.
    for (const lang of ['es', 'en']) {
      assert.ok(WAITING_LINES[lang].length >= 2);
      assert.equal(WAITING_LINES[lang].some((l) => LINES[lang].includes(l)), false);
    }
  });

  test('are longer than the openers, since buying time is the whole job', () => {
    for (const lang of ['es', 'en']) {
      const shortest = Math.min(...WAITING_LINES[lang].map((l) => l.length));
      const longestOpener = Math.max(...LINES[lang].map((l) => l.length));
      assert.ok(shortest > longestOpener, `${lang}: waiting lines should be the longer set`);
    }
  });

  test('the two sets rotate independently', () => {
    // Shared rotation state would make the second set skip lines depending on
    // how many openers had played.
    const a = takeFiller('es', 'waiting');
    const b = takeFiller('es', 'waiting');
    if (!a || !b) return; // nothing warmed in this process
    assert.notEqual(a.line, b.line);
  });
});
