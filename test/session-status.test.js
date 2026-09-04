import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { VoiceSession } from '../src/voice/session.js';

/**
 * `status()`'s panel-facing additions: the music summary and the recent
 * exchanges ring. A real VoiceSession, same as music-mode.test.js — the
 * connection never leaves Signalling with an adapter that answers nobody,
 * which is all this needs.
 */
function session(t, { guildId = 'g1' } = {}) {
  const channel = {
    id: 'c1',
    name: 'general',
    client: { channels: { cache: new Map() } },
    guild: {
      id: guildId,
      name: 'Casa',
      voiceAdapterCreator: () => ({ sendPayload: () => true, destroy: () => {} }),
    },
  };
  const s = new VoiceSession(channel);
  t.after(() => s.destroy());
  return s;
}

describe('the music summary in status()', () => {
  test('matches what the player itself reports', (t) => {
    const s = session(t);
    assert.deepEqual(s.status().music, s.music.status());
    assert.deepEqual(s.status().music, {
      playing: false,
      paused: false,
      title: null,
      queued: 0,
      volume: 100,
    });
  });
});

describe('recordExchange and the recent-exchanges ring', () => {
  test('starts empty', (t) => {
    const s = session(t);
    assert.deepEqual(s.status().recent, []);
  });

  test('one exchange, in the shape the panel reads', (t) => {
    const s = session(t);
    s.recordExchange({
      askedBy: 'Vero',
      question: 'qué hora es',
      answer: 'Las nueve y media.',
      firstAudioMs: 1200,
      totalMs: 3400,
    });

    const [entry] = s.status().recent;
    assert.equal(entry.askedBy, 'Vero');
    assert.equal(entry.question, 'qué hora es');
    assert.equal(entry.answer, 'Las nueve y media.');
    assert.equal(entry.firstAudioMs, 1200);
    assert.equal(entry.totalMs, 3400);
    assert.equal(typeof entry.at, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.at)), 'at must be a parseable ISO string');
  });

  test('newest last', (t) => {
    const s = session(t);
    s.recordExchange({ askedBy: 'Vero', question: 'uno', answer: '1', firstAudioMs: 1, totalMs: 1 });
    s.recordExchange({ askedBy: 'Marco', question: 'dos', answer: '2', firstAudioMs: 1, totalMs: 1 });

    const recent = s.status().recent;
    assert.equal(recent.at(-1).question, 'dos');
    assert.equal(recent.at(0).question, 'uno');
  });

  test('caps at ten, dropping the oldest', (t) => {
    const s = session(t);
    for (let i = 0; i < 14; i += 1) {
      s.recordExchange({ askedBy: 'Vero', question: `q${i}`, answer: `a${i}`, firstAudioMs: 1, totalMs: 1 });
    }

    const recent = s.status().recent;
    assert.equal(recent.length, 10);
    assert.equal(recent.at(0).question, 'q4', 'the first four fell off the front');
    assert.equal(recent.at(-1).question, 'q13');
  });

  test('missing timings become null rather than undefined', (t) => {
    const s = session(t);
    s.recordExchange({ askedBy: 'Vero', question: 'q', answer: 'a' });

    const [entry] = s.status().recent;
    assert.equal(entry.firstAudioMs, null);
    assert.equal(entry.totalMs, null);
  });
});
