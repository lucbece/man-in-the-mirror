import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { mergeLines } from '../src/web/merge-lines.js';

/**
 * The scenario the merge exists for: `base` is what the panel had loaded,
 * `next` is what it is trying to save, `current` is what a voice tool may
 * have changed on disk in between. See src/web/merge-lines.js for the rules.
 */
describe('mergeLines', () => {
  test('a voice line added while the panel edits another line: both survive', () => {
    // Panel loaded "Call Vero jefa." / "Speak slowly.", then rewords the
    // second line while, mid-edit, remember_instruction appends a third to
    // disk. Neither side saw the other's change.
    const base = 'Call Vero jefa.\nSpeak slowly.';
    const current = 'Call Vero jefa.\nSpeak slowly.\nAlways answer in English.';
    const next = 'Call Vero jefa.\nSpeak more slowly please.';

    assert.equal(
      mergeLines(base, next, current),
      'Call Vero jefa.\nAlways answer in English.\nSpeak more slowly please.',
    );
  });

  test('the panel removes a line: gone, even though it is still in current', () => {
    const base = 'Call Vero jefa.\nSpeak slowly.';
    const current = 'Call Vero jefa.\nSpeak slowly.'; // untouched by voice since load
    const next = 'Call Vero jefa.';

    assert.equal(mergeLines(base, next, current), 'Call Vero jefa.');
  });

  test('the panel edits a line: the old wording is removed, the new one added', () => {
    const base = 'Speak slowly.';
    const current = 'Speak slowly.';
    const next = 'Speak more slowly please.';

    assert.equal(mergeLines(base, next, current), 'Speak more slowly please.');
  });

  test('both sides add a line: both kept, the panel\'s after current\'s', () => {
    const base = 'Call Vero jefa.';
    const current = 'Call Vero jefa.\nFede hates pineapple on pizza.'; // voice added this
    const next = 'Call Vero jefa.\nWe play on Fridays.'; // panel added this

    assert.equal(
      mergeLines(base, next, current),
      'Call Vero jefa.\nFede hates pineapple on pizza.\nWe play on Fridays.',
    );
  });

  test('base === current: nothing changed on disk, so this is a plain replace', () => {
    const base = 'Call Vero jefa.\nSpeak slowly.';
    const current = base;
    const next = 'Call Vero jefa.\nAlways answer in English.';

    assert.equal(mergeLines(base, next, current), next);
  });

  test('trailing whitespace and blank lines in base do not read as edits', () => {
    const base = 'Call Vero jefa.\n\n  Speak slowly.  \n\n';
    const current = 'Call Vero jefa.\nSpeak slowly.';
    const next = 'Call Vero jefa.\nSpeak slowly.';

    // Same lines once trimmed, so nothing was added or removed.
    assert.equal(mergeLines(base, next, current), 'Call Vero jefa.\nSpeak slowly.');
  });

  test('next identical to base: current is left exactly as it is, voice line included', () => {
    // The panel saved without touching this field at all, while current has
    // moved on — a save with nothing to say about a field must not undo what
    // voice did to it.
    const base = 'Call Vero jefa.';
    const next = 'Call Vero jefa.';
    const current = 'Call Vero jefa.\nNico is the DM.';

    assert.equal(mergeLines(base, next, current), current);
  });

  test('an added line already present in current is not duplicated', () => {
    const base = 'Call Vero jefa.';
    const current = 'Call Vero jefa.\nWe play on Fridays.'; // voice already added this
    const next = 'Call Vero jefa.\nWe play on Fridays.'; // panel added the same line itself

    assert.equal(mergeLines(base, next, current), 'Call Vero jefa.\nWe play on Fridays.');
  });

  test('empty everywhere is empty', () => {
    assert.equal(mergeLines('', '', ''), '');
  });

  test('base and next both blank/undefined behave like empty strings', () => {
    assert.equal(mergeLines(undefined, undefined, 'Pato is the healer.'), 'Pato is the healer.');
  });
});
