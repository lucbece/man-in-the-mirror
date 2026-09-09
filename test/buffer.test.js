import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AudioBuffer, TYPED_WINDOW_MS, Utterance } from '../src/agent/buffer.js';

const NOW = 1_700_000_000_000;

/** @param packets 25 packets ≈ 500ms, since Discord sends 20ms per frame. */
function utterance({ name, agoSeconds, packets = 25 }) {
  const u = new Utterance({
    userId: name,
    displayName: name,
    startedAt: NOW - agoSeconds * 1000,
  });
  for (let i = 0; i < packets; i++) u.push(Buffer.alloc(60));
  u.endedAt = NOW - agoSeconds * 1000 + packets * 20;
  return u;
}

describe('AudioBuffer', () => {
  test('drops utterances older than the window', () => {
    const buf = new AudioBuffer({ windowSeconds: 180 });
    buf.add(utterance({ name: 'Vero', agoSeconds: 400 }), NOW);
    buf.add(utterance({ name: 'Marco', agoSeconds: 100 }), NOW);
    buf.add(utterance({ name: 'Ana', agoSeconds: 40 }), NOW);

    const kept = buf.recent(NOW);
    assert.equal(kept.length, 2);
    assert.deepEqual(
      kept.map((u) => u.displayName),
      ['Marco', 'Ana'],
    );
  });

  test('returns utterances oldest first regardless of insertion order', () => {
    const buf = new AudioBuffer({ windowSeconds: 180 });
    buf.add(utterance({ name: 'late', agoSeconds: 10 }), NOW);
    buf.add(utterance({ name: 'early', agoSeconds: 90 }), NOW);
    buf.add(utterance({ name: 'middle', agoSeconds: 50 }), NOW);

    assert.deepEqual(
      buf.recent(NOW).map((u) => u.displayName),
      ['early', 'middle', 'late'],
    );
  });

  test('ignores empty utterances', () => {
    const buf = new AudioBuffer({ windowSeconds: 180 });
    buf.add(utterance({ name: 'silent', agoSeconds: 5, packets: 0 }), NOW);
    assert.equal(buf.recent(NOW).length, 0);
  });

  test('only reports untranscribed utterances as pending', () => {
    const buf = new AudioBuffer({ windowSeconds: 180 });
    buf.add(utterance({ name: 'a', agoSeconds: 30 }), NOW);
    buf.add(utterance({ name: 'b', agoSeconds: 20 }), NOW);
    buf.add(utterance({ name: 'c', agoSeconds: 10 }), NOW);

    assert.equal(buf.untranscribed(NOW).length, 3);
    buf.recent(NOW)[0].text = 'already done';

    // This caching is what makes follow-up questions cheap — you only pay for
    // audio that arrived since the last question.
    assert.equal(buf.untranscribed(NOW).length, 2);
    assert.equal(buf.stats(NOW).pendingUtterances, 2);
  });

  test('shrinking the window prunes immediately', () => {
    const buf = new AudioBuffer({ windowSeconds: 300 });
    buf.add(utterance({ name: 'old', agoSeconds: 200 }), NOW);
    buf.add(utterance({ name: 'new', agoSeconds: 10 }), NOW);
    assert.equal(buf.recent(NOW).length, 2);

    buf.setWindow(60, NOW);
    assert.equal(buf.recent(NOW).length, 1);
  });

  test('clear() releases everything, including the byte count', () => {
    const buf = new AudioBuffer({ windowSeconds: 180 });
    buf.add(utterance({ name: 'a', agoSeconds: 10 }), NOW);
    assert.ok(buf.bytes > 0);

    buf.clear();
    assert.equal(buf.recent(NOW).length, 0);
    assert.equal(buf.bytes, 0);
  });

  test('stats counts distinct speakers, not utterances', () => {
    const buf = new AudioBuffer({ windowSeconds: 180 });
    buf.add(utterance({ name: 'Vero', agoSeconds: 30 }), NOW);
    buf.add(utterance({ name: 'Vero', agoSeconds: 20 }), NOW);
    buf.add(utterance({ name: 'Ana', agoSeconds: 10 }), NOW);

    const stats = buf.stats(NOW);
    assert.equal(stats.utterances, 3);
    assert.equal(stats.speakers, 2);
  });
});

describe('a line that was typed rather than said', () => {
  test('reads like speech, in the place in time where it was typed', () => {
    const buffer = new AudioBuffer({ windowSeconds: 60 });
    const spoken = new Utterance({ userId: 'u1', displayName: 'Vero', startedAt: 1000 });
    spoken.push(Buffer.alloc(100));
    spoken.text = 'poné el tema ese';
    buffer.add(spoken, 1000);

    const note = buffer.note({ userId: 'u2', displayName: 'Luc', text: 'Ne me quitte pas' }, 2000);
    assert.ok(note);
    assert.equal(note.text, 'Ne me quitte pas');
    assert.equal(note.typed, true);
    assert.equal(note.durationMs, 0, 'no audio behind it');

    const lines = buffer.recent(2000);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((u) => u.displayName), ['Vero', 'Luc'], 'in the order they happened');
    // The one thing that must hold: the transcriber never tries to transcribe
    // it, because it is already text.
    assert.equal(buffer.untranscribed(2000).length, 0);
  });

  test('an empty note is not a line', () => {
    const buffer = new AudioBuffer({ windowSeconds: 60 });
    assert.equal(buffer.note({ userId: 'u1', displayName: 'Luc', text: '   ' }), null);
    assert.equal(buffer.note({ userId: 'u1', displayName: 'Luc', text: undefined }), null);
    assert.equal(buffer.recent().length, 0);
  });

  test('it outlives the audio window, because retyping it is the thing to avoid', () => {
    const buffer = new AudioBuffer({ windowSeconds: 60 });
    buffer.note({ userId: 'u1', displayName: 'Luc', text: 'BetterSorting_v3' }, 0);

    // Long past the audio window, well inside the typed one.
    assert.equal(buffer.recent(120_000).length, 1, 'still there two minutes later');
    // And eventually it does go.
    assert.equal(buffer.recent(TYPED_WINDOW_MS + 1000).length, 0);
  });

  test('spoken audio still ages out on its own window', () => {
    const buffer = new AudioBuffer({ windowSeconds: 60 });
    const spoken = new Utterance({ userId: 'u1', displayName: 'Vero', startedAt: 0 });
    spoken.push(Buffer.alloc(100));
    buffer.add(spoken, 0);
    buffer.note({ userId: 'u1', displayName: 'Luc', text: 'x' }, 0);

    const left = buffer.recent(120_000);
    assert.equal(left.length, 1, 'the audio is gone and the note is not');
    assert.equal(left[0].typed, true);
  });
});
