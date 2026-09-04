import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ClipLog } from '../src/agent/clip-log.js';

/**
 * The gate drops most of what Discord sends. One line per dropped clip made
 * the log unreadable; these pin the shape that replaced it.
 */
describe('the [stt] clip lines', () => {
  const quiet = (peakDb, ms = 500) => ({ ms, peakDb, rmsDb: peakDb - 20, activeRatio: 0 });
  const voice = { ms: 2100, peakDb: -6, rmsDb: -24, activeRatio: 0.7 };

  function harness(opts = {}) {
    const lines = [];
    const timers = [];
    let t = 0;
    const log = new ClipLog({
      log: (l) => lines.push(l),
      now: () => t,
      schedule: (fn) => timers.push(fn),
      verbose: false,
      ...opts,
    });
    return { log, lines, timers, tick: (ms) => { t += ms; } };
  }

  test('dropped clips are tallied and written before the next kept one, in order', () => {
    const { log, lines } = harness();
    log.quiet(quiet(-70));
    log.quiet(quiet(-45, 1200));
    log.quiet(quiet(-58));
    assert.deepEqual(lines, [], 'nothing yet: the tally is open');
    log.kept(voice);
    assert.deepEqual(lines, [
      '[stt] 3 clips too quiet, not sent (2.2s in all, loudest peak -45dB)',
      '[stt] clip 2.1s peak -6dB rms -24dB active 70% → kept',
    ]);
  });

  test('the loudest dropped peak is the number kept: it is the one nearest the threshold', () => {
    const { log, lines } = harness();
    log.quiet(quiet(-80));
    log.quiet(quiet(-41));
    log.quiet(quiet(-66));
    log.flush();
    assert.match(lines[0], /loudest peak -41dB/);
  });

  test('a discarded transcription flushes the tally too', () => {
    const { log, lines } = harness();
    log.quiet(quiet(-70));
    log.discarded(voice, '  Subtítulos realizados por la comunidad de Amara.org  ');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[stt\] 1 clip too quiet/);
    assert.match(lines[1], /discarded, nobody said this: "Subtítulos realizados por la comunidad de Amara.org"$/);
  });

  test('a tally older than the interval is written when the next quiet clip arrives', () => {
    const { log, lines, tick } = harness({ everyMs: 1000 });
    log.quiet(quiet(-70));
    tick(1500);
    log.quiet(quiet(-60));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[stt\] 1 clip too quiet/);
    log.flush();
    assert.equal(lines.length, 2);
  });

  test('a tally on its own is scheduled to be written after the interval', () => {
    const { log, lines, timers } = harness();
    log.quiet(quiet(-70));
    assert.equal(timers.length, 1);
    timers[0]();
    assert.equal(lines.length, 1);
    timers[0]();
    assert.equal(lines.length, 1, 'a second firing has nothing to write');
  });

  test('flush with nothing pending writes nothing', () => {
    const { log, lines } = harness();
    log.flush();
    assert.deepEqual(lines, []);
  });

  test('MIRROR_STT_CLIP_LOG=all keeps one line per clip', () => {
    const { log, lines } = harness({ verbose: true });
    log.quiet(quiet(-70));
    assert.deepEqual(lines, ['[stt] clip 0.5s peak -70dB rms -90dB active 0% → too quiet, not sent']);
  });
});
