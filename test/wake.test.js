import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { detectAddress, onlyTheName } from '../src/agent/wake.js';

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

describe('loose matching without false positives', () => {
  const NAMES = 'mirror, espejo';

  test('lets through what speech recognition actually produces', () => {
    // All observed in live sessions, or one edit away from something that was.
    for (const heard of [
      'mirra qué opinás',
      'mirrow what now',
      'espejito decime algo',
      'spejo estás ahí',
      'el mirror escuchás',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, true, `missed: ${heard}`);
    }
  });

  test('common words never count, however close they score', () => {
    // "espero" is 0.83 against "espejo" and "miro" is 0.67 against "mirror" —
    // both above the threshold, and both said constantly. Excluding them by
    // name is what lets the threshold be loose enough to be useful.
    for (const heard of [
      'espero que sí',
      'esperá un toque',
      'te espero afuera',
      'mira quién volvió',
      'yo miro la tele',
      'mejor no',
      'ya te dejo',
      'el viejo ese',
      'quiero eso',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, false, `false positive: ${heard}`);
    }
  });

  test('a name that is itself a common word still matches exactly', () => {
    // Someone could reasonably name it "espera"; the exclusion must not stop
    // the configured name from matching itself.
    assert.equal(detectAddress('espera decime algo', 'espera').matched, true);
  });
});

describe('words a real call proved were missing', () => {
  const NAMES = 'mirror, espejo';

  test('the infinitive of mirar is not a summons', () => {
    // "El que se debe mirar" woke the bot in a live call. The conjugations
    // were all excluded; the infinitive — the form people actually reach for —
    // was not, and it scores 0.667 against "mirror".
    for (const heard of [
      'el que se debe mirar',
      'hay que mirar bien eso',
      'vine a mirarte nomás',
      'nos miraron raro',
      'subimos al mirador',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, false, `false positive: ${heard}`);
    }
  });

  test('the subjunctive of esperar is not a summons either', () => {
    for (const heard of ['espere un momento', 'esperes lo que esperes', 'esperemos a que llegue']) {
      assert.equal(detectAddress(heard, NAMES).matched, false, `false positive: ${heard}`);
    }
  });

  test('diminutives and plurals of the name still call it', () => {
    // The other half: excluding too much would be its own failure.
    for (const heard of ['espejito, decime algo', 'espejo, qué hacés']) {
      assert.equal(detectAddress(heard, NAMES).matched, true, `missed: ${heard}`);
    }
  });
});

describe('talked about, not talked to', () => {
  const NAMES = 'mirror, espejo, sombrero';

  test('an article before the name means the room is discussing it', () => {
    // Every one of these woke the bot in a live call, and none of them was
    // addressed to it — which is what made it look like it talks to itself.
    for (const heard of [
      'lo que hace el espejo no me incumbe',
      'picante encima del espejo',
      'pintan mal las cosas para el espejo, pintan mal',
      'este espejo está re raro, amigo',
      'sí, comienzo a ver un sombrero',
      'me voy a quitar mis sombreros',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, false, `false positive: ${heard}`);
    }
  });

  test('a vocative takes no article, and negation is not an article', () => {
    // The near misses of the rule: all of these are people talking to it.
    for (const heard of [
      'no, espejo, ponelo de nuevo',
      'de una, espejo, yo te aviso',
      'qué frío que hace, ¿no, espejo?',
      'espejo, poné música',
      'che espejo, qué opinás',
    ]) {
      assert.equal(detectAddress(heard, NAMES).matched, true, `missed: ${heard}`);
    }
  });

  test('speaking to someone lets an article through', () => {
    // Around here an article before a name is ordinary — "el Diego", "la
    // Vero" — so a second person anywhere in the sentence keeps the wake.
    // The cost is a line like "vos tenés un espejo también", which talks to a
    // person about a mirror and still wakes it; rarer than the alternative.
    for (const heard of ['el mirror, estás escuchando?', 'ah, vos tenés un espejo también, mirá vos']) {
      assert.equal(detectAddress(heard, NAMES).matched, true, `missed: ${heard}`);
    }
  });

  test('the name said plainly later in the sentence still counts', () => {
    const heard = 'el espejo este no anda, espejo, ¿estás ahí?';
    assert.equal(detectAddress(heard, NAMES).matched, true);
  });
});

describe('onlyTheName', () => {
  const NAMES = 'mirror, espejo';
  test('the name alone, however the transcriber spelt it', () => {
    for (const heard of ['espejo', 'Espejo.', 'espelho', 'mirr', 'mirror', 'Espejo, espejo.', 'espejito']) {
      assert.equal(onlyTheName(heard, NAMES), true, heard);
    }
  });
  test('anything else beside it is a request', () => {
    for (const heard of ['espejo, ¿qué hora es?', 'che espejo', 'hola espejo', 'dale', '']) {
      assert.equal(onlyTheName(heard, NAMES), false, heard);
    }
  });
});
