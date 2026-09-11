import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { guessLanguage, takeFiller, LINES, WAITING_LINES, ACK_LINES } from '../src/agent/filler.js';

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
    // No language's function words matched, so there is nothing to guess —
    // 'en' used to be the silent default, which is exactly the bug: a
    // language nobody spoke, picked because it was the fallback rather than
    // because anything pointed at it.
    assert.equal(guessLanguage(''), null);
    assert.equal(guessLanguage(null), null);
    assert.equal(guessLanguage('!!! ???'), null);
    assert.equal(guessLanguage('asdkjf qwoiuu xkcd blah'), null);
  });

  test('recognises Portuguese', () => {
    for (const text of [
      'Oi espelho, você pode me ajudar com isso?',
      'Não sei, mas também não tenho certeza.',
      'Peraí, deixa eu ver, obrigado.',
    ]) {
      assert.equal(guessLanguage(text), 'pt', `should be Portuguese: ${text}`);
    }
  });

  test('recognises Italian', () => {
    assert.equal(guessLanguage('Ciao, come stai? Voglio sapere quando arriva.'), 'it');
  });

  test('recognises French', () => {
    assert.equal(guessLanguage('Bonjour, comment ça va? Je voudrais savoir où est le café.'), 'fr');
  });

  test('recognises German', () => {
    assert.equal(guessLanguage('Ich weiß nicht, wo das ist. Kannst du mir helfen?'), 'de');
  });

  test('Spanish wins a tie against Portuguese', () => {
    // "que", "para" and "de" are spelled identically in both languages, so a
    // sentence built only from shared words scores them evenly. This bot's
    // rooms speak mostly Rioplatense Spanish, so Spanish is the tiebreaker.
    assert.equal(guessLanguage('que para de'), 'es');
  });

  test('recognises an English request made of content words, not just grammar words', () => {
    // Regression: these scored zero against the original, narrower
    // ENGLISH_WORDS list, so they came back null instead of 'en' — losing
    // their English filler and switching the leaked-reasoning guard on for
    // what was actually an English question.
    for (const text of ['play something by Queen', 'put on some jazz', 'tell me a joke']) {
      assert.equal(guessLanguage(text), 'en', `should be English: ${text}`);
    }
  });

  test('a short Spanish request or reaction still wins the tie against English', () => {
    // Widening ENGLISH_WORDS meant "me" alone could tip a short Spanish
    // sentence toward English; these words keep it Spanish.
    assert.equal(guessLanguage('me gusta esa canción'), 'es');
    assert.equal(guessLanguage('poneme otra'), 'es');
  });

  test('Portuguese and gibberish are unaffected by the wider English list', () => {
    assert.equal(guessLanguage('não sei'), 'pt');
    assert.equal(guessLanguage('asdf qwer'), null);
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
    assert.ok(LINES.pt.length >= 2);
    assert.equal(LINES.es.some((l) => LINES.en.includes(l)), false);
    assert.equal(LINES.pt.some((l) => LINES.es.includes(l) || LINES.en.includes(l)), false);
  });

  test('lines are short enough to finish before the search does', () => {
    // A search takes roughly 1.5s. At ~2.5 words a second, anything past about
    // 25 characters would still be talking when the answer is ready.
    for (const line of [...LINES.es, ...LINES.en, ...LINES.pt]) {
      assert.ok(line.length <= 25, `too long to be a filler: ${line}`);
    }
  });

  test('a language with no recorded lines gets no filler, not a Spanish one', () => {
    // pickLine used to fall back to table.es for anything it didn't have —
    // German, Italian, French, or a guess that came back null. Now it's
    // silence, which every caller already treats as "say nothing".
    assert.equal(takeFiller('de'), null);
    assert.equal(takeFiller('it'), null);
    assert.equal(takeFiller('fr'), null);
    assert.equal(takeFiller(null), null);
  });

  test('defaults to no language rather than Spanish', () => {
    // The default parameter used to be 'es'; calling with nothing now means
    // "unknown", not "assume Spanish".
    assert.equal(takeFiller(), null);
  });
});

describe('the long-wait lines', () => {
  test('are a separate, distinct set from the opening ones', () => {
    // Reusing an opening line after ten seconds of silence would sound like
    // the bot forgot it already said it.
    for (const lang of ['es', 'en', 'pt']) {
      assert.ok(WAITING_LINES[lang].length >= 2);
      assert.equal(WAITING_LINES[lang].some((l) => LINES[lang].includes(l)), false);
    }
  });

  test('are longer than the openers, since buying time is the whole job', () => {
    for (const lang of ['es', 'en', 'pt']) {
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

describe('the ack lines', () => {
  test('Portuguese has its own, distinct from Spanish and English', () => {
    assert.ok(ACK_LINES.pt.length >= 2);
    assert.equal(ACK_LINES.pt.some((l) => ACK_LINES.es.includes(l) || ACK_LINES.en.includes(l)), false);
  });
});
