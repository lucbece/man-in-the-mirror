import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { looksHallucinated, echoesPrompt, namePrompt } from '../src/agent/stt.js';

// The one that started this. Reported from a live channel with nobody
// speaking, and repeated verbatim — which is the tell.
const IGLESIA =
  'Este es el canal de subtítulos en español de la Iglesia de Jesucristo de ' +
  'los santos de los últimos días. Este es el canal de subtítulos en español ' +
  'de la Iglesia de Jesucristo de los santos de los últimos días.';

describe('Whisper hallucinations', () => {
  test('rejects the subtitle boilerplate that was actually seen', () => {
    assert.equal(looksHallucinated(IGLESIA, 8000), true);
  });

  test('rejects it at any length, since the old filter only looked at short clips', () => {
    // The previous version gave up above 2.5s, which is exactly why this one
    // reached the transcript.
    for (const ms of [1000, 8000, 30000, 120000]) {
      assert.equal(looksHallucinated(IGLESIA, ms), true, `should reject at ${ms}ms`);
    }
  });

  test('rejects more words than the clip could hold', () => {
    // Twenty words in one second is not something a person did.
    const veinte = Array.from({ length: 20 }, (_, i) => `palabra${i}`).join(' ');
    assert.equal(looksHallucinated(veinte, 1000), true);
    // The same words over ten seconds is just someone talking.
    assert.equal(looksHallucinated(veinte, 10000), false);
  });

  test('rejects a sentence looped verbatim', () => {
    // Catches boilerplate nobody has reported yet, which the phrase list
    // cannot do by construction.
    const loop = 'Bueno pero eso no tiene sentido. Bueno pero eso no tiene sentido.';
    assert.equal(looksHallucinated(loop, 12000), true);
  });

  test('keeps real speech, including things that resemble the stock phrases', () => {
    const reales = [
      ['Che, ¿conviene hacer el asado el jueves o el sábado?', 4000],
      ['Gracias por pasarme el link, lo miro más tarde y te digo.', 5000],
      ['No, pará, lo que yo decía era otra cosa. Escuchame un segundo.', 6000],
      ['Sí. Sí, claro. Obvio.', 3000],
      ['Mirá, yo lo veo así: si llueve el jueves, lo movemos.', 5000],
    ];
    for (const [texto, ms] of reales) {
      assert.equal(looksHallucinated(texto, ms), false, `descartó habla real: ${texto}`);
    }
  });

  test('still drops a bare "gracias" on a very short clip', () => {
    assert.equal(looksHallucinated('Gracias.', 1200), true);
    // But not when it's clearly part of a real utterance.
    assert.equal(looksHallucinated('Gracias.', 9000), false);
  });

  test('empty and whitespace are not hallucinations, just nothing', () => {
    assert.equal(looksHallucinated('', 3000), false);
    assert.equal(looksHallucinated('   ', 3000), false);
  });
});

describe('the prompt coming back as if someone said it', () => {
  // The worst of these, because the prompt is the bot's own names: the echo
  // reads as somebody calling the bot, and the bot answers itself. Reported
  // live, over and over, with nobody speaking.
  const VIEJO = 'Conversación en un canal de voz con un asistente llamado mirror o espejo.';

  test('rejects the old sentence-shaped prompt, however it comes back', () => {
    for (const eco of [
      'Ese es el canal de voz con un asistente llamado mirror o espejo',
      'Este es el canal de voz con un asistente llamado mirror o espejo.',
      'Conversación en un canal de voz con un asistente llamado mirror o espejo.',
    ]) {
      assert.equal(echoesPrompt(eco, VIEJO), true, `dejó pasar: ${eco}`);
    }
  });

  test('rejects the bare name list coming back', () => {
    assert.equal(echoesPrompt('mirror, espejo', 'mirror, espejo'), true);
    assert.equal(echoesPrompt('Mirror. Espejo.', 'mirror, espejo'), true);
  });

  test('lets someone actually calling the bot through', () => {
    // The whole point of the bot. Over-filtering here would make it deaf.
    for (const real of [
      'Espejo, decime si conviene el jueves',
      'Che mirror, qué opinás de esto',
      '¿Espejo estás ahí? Te estoy hablando',
      'mirror',
    ]) {
      assert.equal(echoesPrompt(real, 'mirror, espejo'), false, `descartó: ${real}`);
    }
  });

  test('an empty prompt cannot be echoed', () => {
    assert.equal(echoesPrompt('cualquier cosa', ''), false);
    assert.equal(echoesPrompt('', 'mirror, espejo'), false);
  });
});
