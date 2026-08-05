import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { clampForSpeech, MAX_SPOKEN_CHARS } from '../src/agent/brain.js';

/** Anything here read aloud is either gibberish or a minute of wasted airtime. */
const UNSPEAKABLE = /[*_#`]|\n|https?:\/\/|www\./i;

describe('clampForSpeech', () => {
  test('leaves a normal short reply alone', () => {
    const input = 'Marco is right, he said Friday.';
    assert.equal(clampForSpeech(input), input);
  });

  test('strips markdown emphasis and code spans', () => {
    const out = clampForSpeech('**Marco** is right — he said `Friday`.');
    assert.equal(out, 'Marco is right — he said Friday.');
  });

  test('keeps link text but drops the URL', () => {
    // Read aloud, a URL becomes "h t t p colon slash slash" for ten seconds.
    const out = clampForSpeech('See [the thread](https://example.com/a/b) for that.');
    assert.equal(out, 'See the thread for that.');
    assert.doesNotMatch(out, UNSPEAKABLE);
  });

  test('removes bare URLs and domains', () => {
    const out = clampForSpeech('Check www.example.com or https://foo.bar/baz.');
    assert.doesNotMatch(out, UNSPEAKABLE);
  });

  test('removes fenced code entirely', () => {
    const out = clampForSpeech('Try this: ```js\nconst x = 1;\n``` and see.');
    assert.doesNotMatch(out, /const x/);
    assert.doesNotMatch(out, UNSPEAKABLE);
  });

  test('flattens bullet and numbered lists', () => {
    const bullets = clampForSpeech('Options:\n- first\n- second');
    const numbered = clampForSpeech('Steps:\n1. first\n2. second');
    for (const out of [bullets, numbered]) {
      assert.doesNotMatch(out, UNSPEAKABLE);
      assert.match(out, /first/);
      assert.match(out, /second/);
    }
  });

  test('caps length even when the model ignores the prompt', () => {
    const rambling = 'This is a whole sentence that keeps going. '.repeat(40);
    const out = clampForSpeech(rambling);
    assert.ok(out.length <= MAX_SPOKEN_CHARS, `${out.length} chars exceeds the cap`);
  });

  test('prefers cutting at a sentence boundary', () => {
    const out = clampForSpeech('Short one. ' + 'Filler sentence here. '.repeat(40));
    // Ending on a full stop sounds deliberate; ending mid-clause sounds broken.
    assert.match(out, /\.$/);
  });

  test('falls back to an ellipsis when there is no sentence break', () => {
    const out = clampForSpeech('word '.repeat(300));
    assert.ok(out.length <= MAX_SPOKEN_CHARS);
    assert.match(out, /…$/);
  });

  test('never returns leading or trailing whitespace', () => {
    assert.equal(clampForSpeech('   padded reply.   '), 'padded reply.');
  });
});

describe('web search citations', () => {
  test('strips the citation OpenAI search actually returns', () => {
    const real =
      'No se espera lluvia en Buenos Aires hoy. ' +
      '([lanacion.com.ar](https://www.lanacion.com.ar/clima/buenos-aires))';
    const out = clampForSpeech(real);
    assert.equal(out, 'No se espera lluvia en Buenos Aires hoy.');
    assert.doesNotMatch(out, UNSPEAKABLE);
  });

  test('strips several citations in one answer', () => {
    const out = clampForSpeech(
      'Va a llover. ([a.com](https://a.com)) Y hará frío. ([b.com.ar](https://b.com.ar))',
    );
    assert.doesNotMatch(out, /a\.com|b\.com/);
    assert.match(out, /Va a llover/);
    assert.match(out, /hará frío/);
  });

  test('strips a bare domain left loose in prose', () => {
    const out = clampForSpeech('Según lanacion.com.ar, no va a llover.');
    assert.doesNotMatch(out, /lanacion/);
  });

  test('leaves ordinary sentences with full stops alone', () => {
    // The domain pattern must not eat normal punctuation.
    const text = 'Creo que sí. Pero no estoy seguro. Preguntale a Marco.';
    assert.equal(clampForSpeech(text), text);
  });
});

describe('clampForSpeech never exceeds its limit', () => {
  test('the ellipsis comes out of the budget, not on top of it', () => {
    // Found by a test of ask(): the running budget subtracts what was returned,
    // so one character over per chunk accumulated across an answer instead of
    // staying a rounding error.
    for (const limit of [10, 40, 59, 100, 380]) {
      const largo = 'palabra '.repeat(80);
      const out = clampForSpeech(largo, limit);
      assert.ok(out.length <= limit, `limit ${limit} produced ${out.length} characters`);
    }
  });

  test('still cuts at a sentence boundary when there is one', () => {
    const texto = 'Primera oración corta. Y después una segunda mucho más larga que no entra.';
    const out = clampForSpeech(texto, 40);
    assert.ok(out.length <= 40);
    assert.ok(out.endsWith('.'), `should end on a full stop, got: ${out}`);
  });

  test('a text within the limit is returned whole', () => {
    assert.equal(clampForSpeech('Corto y listo.', 380), 'Corto y listo.');
  });
});
