import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';

import { recapCall, recapPrompt, parseRecap, MIN_EXCHANGES } from '../src/agent/recap.js';
import { config } from '../src/config.js';

let snapshot;
let persist;
beforeEach(() => {
  snapshot = { ...config.values };
  persist = config.persist;
  config.persist = () => {};
  config.values.notebook = '';
});
afterEach(() => {
  config.persist = persist;
  config.values = snapshot;
});

const exchanges = [
  { askedBy: 'Vero', question: 'espejo, qué opinás de Coltrane', answer: 'Un gigante, sobre todo A Love Supreme.' },
  { askedBy: 'Fede', question: 'espejo, el viernes jugamos truco, acordate', answer: 'Anotado, el viernes truco.' },
];

describe('the end-of-call recap', () => {
  test('asks once and writes what came back into the notebook', async () => {
    const calls = [];
    const added = await recapCall({
      exchanges,
      log: () => {},
      complete: async (prompt) => {
        calls.push(prompt);
        return '["A Vero le gusta Coltrane", "El viernes juegan al truco"]';
      },
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /Vero: espejo, qué opinás de Coltrane/);
    assert.deepEqual(added, ['A Vero le gusta Coltrane', 'El viernes juegan al truco']);
    assert.equal(config.get('notebook'), 'A Vero le gusta Coltrane\nEl viernes juegan al truco');
  });

  test('a call with too little in it is not worth a request', async () => {
    let called = false;
    const added = await recapCall({
      exchanges: exchanges.slice(0, MIN_EXCHANGES - 1),
      log: () => {},
      complete: async () => {
        called = true;
        return '["x"]';
      },
    });
    assert.equal(called, false);
    assert.deepEqual(added, []);
  });

  test('what is already known is not written twice, and prose around the JSON is tolerated', async () => {
    config.values.notebook = 'A Vero le gusta Coltrane';
    const added = await recapCall({
      exchanges,
      log: () => {},
      complete: async () => 'Sure, here you go:\n```json\n["a vero le gusta coltrane", "El viernes juegan al truco"]\n```',
    });
    assert.deepEqual(added, ['El viernes juegan al truco']);
    assert.equal(config.get('notebook'), 'A Vero le gusta Coltrane\nEl viernes juegan al truco');
  });

  test('an answer that is not a list adds nothing and throws nothing', async () => {
    const added = await recapCall({ exchanges, log: () => {}, complete: async () => 'Nothing worth keeping.' });
    assert.deepEqual(added, []);
    assert.equal(config.get('notebook'), '');
  });

  test('parseRecap caps the count, drops non-strings and over-long lines', () => {
    assert.deepEqual(parseRecap('[1, "a", "b", "c", "d"]'), ['a', 'b', 'c']);
    assert.deepEqual(parseRecap(`["${'x'.repeat(300)}", "ok"]`), ['ok']);
    assert.deepEqual(parseRecap('[]'), []);
    assert.deepEqual(parseRecap(''), []);
  });

  test('the prompt shows the notebook so the model can skip what is there', () => {
    const prompt = recapPrompt({ exchanges, notebook: ['A Vero le gusta Coltrane'] });
    assert.match(prompt, /Already in the notebook:\n- A Vero le gusta Coltrane/);
    assert.match(prompt, /JSON array of strings only/);
  });
});
