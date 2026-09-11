import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  isStageDirection,
  looksLikeLeakedReasoning,
  mentionsLanguageSwitch,
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
  const asked = 'espejo, che, escuchá lo que dijo vero';

  test('the three that were actually heard in the channel', () => {
    for (const leaked of [
      'I don\'t see an actual question here — vero just said "4. Mueh", which looks like they are still talking to ran, or testing the mic.',
      'I hear the setup to a joke, but Dr Luchi has not finished asking yet — they are mid-sentence.',
      'Nico just said "wtf mi horror". That is not really a question directed at me, so there is nothing to answer.',
    ]) {
      assert.equal(looksLikeLeakedReasoning(leaked, asked), true, leaked.slice(0, 40));
    }
  });

  test('the fourth, on a question made only of small words', () => {
    // The guard was in place and did not fire, because "Al fin y al cabo."
    // was classified as English — see filler.test.js. This pins the pair.
    const said = 'I need to work out what fede is actually asking here.';
    assert.equal(looksLikeLeakedReasoning(said, 'Al fin y al cabo.'), true);
    assert.equal(looksLikeLeakedReasoning(said, 'Espejo, la concha de tu madre.'), true);
  });

  test('the fifth, on a one-word answer in the reply window', () => {
    // "¡No!" is a word in both languages, so the question alone said nothing
    // about the room; the guard has to be told what the room speaks. And the
    // paragraph is deliberation from its first words, which is caught on its
    // own before any language is weighed.
    const said =
      'I\'m only hearing "¡No!" without a question directed at me. ' +
      'That\'s vero reacting to something in the conversation, not asking me anything. ' +
      'I\'ll stay quiet and let the chat continue.';
    assert.equal(looksLikeLeakedReasoning(said, '¡No!', { room: 'es' }), true);
    assert.equal(looksLikeLeakedReasoning(said, '¡No!'), true, 'the words give it away on their own');
    assert.equal(looksLikeLeakedReasoning("I'll stay quiet and let the chat continue.", 'ok'), true);
    assert.equal(looksLikeLeakedReasoning('Me quedo callado, no me están preguntando nada.', 'no'), true);
  });

  test('a short question in a Spanish room still gets the language check', () => {
    const said = 'That is vero reacting to the previous message, so there is nothing for me here.';
    assert.equal(looksLikeLeakedReasoning(said, 'Sí.', { room: 'es' }), true);
    assert.equal(looksLikeLeakedReasoning(said, 'Sí.', { room: 'en' }), false);
    assert.equal(looksLikeLeakedReasoning('No, I don\'t think so, the servers were down all weekend.', 'No?', { room: 'en' }), false);
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

  test('a German question still gets the guard — the guard is not Spanish-only', () => {
    // guessLanguage used to only ever answer 'es' or 'en', so a German room
    // (or Portuguese, or anything else) was silently treated as English and
    // this check switched itself off entirely. It now runs for any language
    // that is not English.
    const german = 'Ich weiß nicht, wo das ist. Kannst du mir helfen?';
    const said = 'The speaker is asking about something else entirely, I think.';
    assert.equal(looksLikeLeakedReasoning(said, german), true);
  });

  test('an English question still turns the guard off', () => {
    const englishQuestion = 'mirror, what do you think about that?';
    const said = 'The speaker is asking about something else entirely, I think.';
    assert.equal(looksLikeLeakedReasoning(said, englishQuestion), false);
  });
});

/**
 * The other side of the same guard: measured over five days of production
 * logs (2026-09-06..10), the language rule above dropped 19 sentences, all
 * legitimate, zero real leaks. Every one was an English answer given after
 * someone in the call had asked, in Spanish, for the bot to switch — so
 * `languageRequested` exists to tell the guard that's what happened.
 */
describe('an English answer after a language request is not reasoning', () => {
  const askedForEnglish = 'Espejo, ¿podemos hablar en inglés de ahora en más, por favor?';

  // Nicknames replaced with placeholders (Vero, Fede, Pato, Nico), as in the
  // rest of this file. Verbatim from the logs otherwise.
  const legitimateReplies = [
    "Sure thing Fede, from now on I'll speak in English.",
    "Alright, from now on, I'll speak in English, Fede.",
    'I can speak in English if you want.',
    "Got it, I'll stick to English — you have my word, Fede.",
    'All good, Fede. Just chilling here, ready for whatever you need.',
    "Right now I'm just vibing with you all, Fede.",
    'Sticking to English only from here on, promise.',
    'Just let me know if you wanna go back to Spanish later.',
    "Sure, from now on, let's switch to English, just like Fede asked.",
  ];

  test('every one of them survives once the caller says the language was requested', () => {
    for (const line of legitimateReplies) {
      assert.equal(
        looksLikeLeakedReasoning(line, askedForEnglish, { languageRequested: true }),
        false,
        line,
      );
    }
  });

  test('the same lines were dropped without the flag — the bug this fixes', () => {
    for (const line of legitimateReplies) {
      assert.equal(looksLikeLeakedReasoning(line, askedForEnglish), true, line);
    }
  });

  test('the flag does not open the door for actual reasoning', () => {
    // languageRequested only skips the language arithmetic. DELIBERATION is
    // checked first and still applies.
    const openers = [
      'I need to work out what fede is actually asking here.',
      'Looking at the context:',
      'I\'m only hearing "¡No!" without a question directed at me. ' +
        "I'll stay quiet and let the chat continue.",
    ];
    for (const said of openers) {
      assert.equal(looksLikeLeakedReasoning(said, askedForEnglish), true, said);
      assert.equal(
        looksLikeLeakedReasoning(said, askedForEnglish, { languageRequested: true }),
        true,
        said,
      );
    }
  });

  test('nor does it drop ordinary English lines that merely echo the broadened wording', () => {
    // Each of these was a plausible spoken answer that the first, wider draft
    // of these patterns would have caught: "let me check", "the speaker is",
    // "they're talking about" are all things a normal reply says. Narrowed so
    // only the actual leaks' wording ("i need to work out", "the user is",
    // "is actually asking") trips them.
    for (const said of [
      'Let me check the server.',
      'The speaker is muted, Fede.',
      "They're talking about the server, Fede.",
    ]) {
      assert.equal(
        looksLikeLeakedReasoning(said, askedForEnglish, { languageRequested: true }),
        false,
        said,
      );
    }
  });
});

describe('mentionsLanguageSwitch', () => {
  test('the actual requests heard in the channel', () => {
    for (const said of [
      'Espejo, ¿podemos hablar en inglés de ahora en más, por favor?',
      'Espejo, cambiá tu idioma.',
    ]) {
      assert.equal(mentionsLanguageSwitch(said), true, said);
    }
  });

  test('asking for or about a language, in either language, accents or not', () => {
    for (const said of [
      'can you speak in english from now on?',
      'hablemos en espanol de nuevo',
      'en castellano, por favor',
      'what language are you using?',
      'ese es tu idioma nativo?',
      'is spanish your first language?',
    ]) {
      assert.equal(mentionsLanguageSwitch(said), true, said);
    }
  });

  test('unrelated Spanish and English sentences are left alone', () => {
    for (const said of [
      '¿Qué hacés, espejo?',
      'Está sonando Californication, del disco que se llama igual.',
      'what time is it',
      'Sticking to this only from here on, promise.',
    ]) {
      assert.equal(mentionsLanguageSwitch(said), false, said);
    }
  });
});
