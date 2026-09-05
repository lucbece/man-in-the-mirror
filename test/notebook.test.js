import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { addNote, removeNote, notebookBlock, MAX_NOTES, MAX_NOTE_CHARS, NotebookError } from '../src/agent/notebook.js';
import { promptWithInstructions } from '../src/agent/brain.js';
import { config } from '../src/config.js';

describe('the notebook', () => {
  test('adds a note, refuses a duplicate, an empty one and a long one', () => {
    const list = addNote('', 'A Vero le gusta el jazz');
    assert.deepEqual(list, ['A Vero le gusta el jazz']);
    assert.throws(() => addNote(list.join('\n'), 'a vero le gusta el JAZZ'), NotebookError);
    assert.throws(() => addNote('', '   '), NotebookError);
    assert.throws(() => addNote('', 'x'.repeat(MAX_NOTE_CHARS + 1)), NotebookError);
  });

  test('stops at the cap and says so', () => {
    const full = Array.from({ length: MAX_NOTES }, (_, i) => `nota ${i}`).join('\n');
    assert.throws(() => addNote(full, 'una más'), /Forget one/);
  });

  test('forgets by number and hands the line back rendered', () => {
    const { list, removed } = removeNote('uno\n<@1|Fede> odia el frío\ntres', 2, (id) => (id === '1' ? 'Federico' : undefined));
    assert.deepEqual(list, ['uno', 'tres']);
    assert.equal(removed, 'Federico odia el frío');
    assert.throws(() => removeNote('uno', 5), NotebookError);
  });

  test('the prompt block frames notes as facts, numbered, and is absent when empty', () => {
    assert.equal(notebookBlock(''), '');
    const block = notebookBlock('A Vero le gusta el jazz\nEl viernes juegan al truco');
    assert.match(block, /facts you picked up, not rules/);
    assert.match(block, /1\. A Vero le gusta el jazz\n2\. El viernes juegan al truco$/);
  });

  test('the system prompt carries the notebook after the instructions', (t) => {
    const before = { ...config.values };
    const persist = config.persist;
    config.persist = () => {};
    t.after(() => {
      config.persist = persist;
      config.values = before;
    });
    config.values.customInstructions = 'Llamame Espejito';
    config.values.notebook = 'A Vero le gusta el jazz';
    const prompt = promptWithInstructions('g', '', () => undefined);
    const i = prompt.indexOf('1. Llamame Espejito');
    const n = prompt.indexOf('1. A Vero le gusta el jazz');
    assert.ok(i > 0 && n > i, 'instructions first, then the notebook');
  });
});
