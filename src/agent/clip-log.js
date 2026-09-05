/**
 * The `[stt] clip` lines, kept readable.
 *
 * Every clip Discord hands over is measured before it is sent (energy.js),
 * and most of them are nothing: a breath, a key, a chair, dropped by the gate
 * without a request. Logging each one was right while the gate was new and
 * wrong once it worked — an evening produced hundreds of "too quiet" lines
 * around a handful that mattered, and the lines that mattered were the ones
 * a reader was scrolling past.
 *
 * So the quiet ones are tallied and written as one line: how many, how long,
 * and the loudest peak among them, which is the only number tuning the
 * threshold needs (a dropped clip close to the threshold is the one to look
 * at). The tally is flushed before the next clip that was sent, so the order
 * of events is preserved, and after a minute on its own so it never sits.
 *
 *   MIRROR_STT_CLIP_LOG=all   → the old behaviour, one line per clip.
 */

import { describeEnergy } from './energy.js';

const EVERY_MS = 60_000;

export class ClipLog {
  constructor({
    log = (line) => console.log(line),
    now = Date.now,
    everyMs = EVERY_MS,
    verbose = /^(all|every|1|true|yes)$/i.test(process.env.MIRROR_STT_CLIP_LOG ?? ''),
    schedule = (fn, ms) => setTimeout(fn, ms).unref?.(),
  } = {}) {
    this.log = log;
    this.now = now;
    this.everyMs = everyMs;
    this.verbose = verbose;
    this.schedule = schedule;
    this.tally = null; // {count, ms, peakDb, since}
  }

  /** A clip the gate refused. */
  quiet(energy) {
    if (this.verbose) {
      this.log(`[stt] clip ${describeEnergy(energy)} → too quiet, not sent`);
      return;
    }
    if (this.tally && this.now() - this.tally.since >= this.everyMs) this.flush();
    if (!this.tally) {
      this.tally = { count: 0, ms: 0, peakDb: -Infinity, since: this.now() };
      this.schedule(() => this.flush(), this.everyMs);
    }
    this.tally.count += 1;
    this.tally.ms += energy.ms;
    this.tally.peakDb = Math.max(this.tally.peakDb, energy.peakDb);
  }

  /** A clip that was sent and came back as speech. */
  kept(energy) {
    this.flush();
    this.log(`[stt] clip ${describeEnergy(energy)} → kept`);
  }

  /** A clip that was sent and came back as something nobody said. */
  discarded(energy, text) {
    this.flush();
    this.log(`[stt] clip ${describeEnergy(energy)} → discarded, nobody said this: "${String(text).trim().slice(0, 80)}"`);
  }

  /** Writes the pending tally, if any, as one line. */
  flush() {
    const t = this.tally;
    this.tally = null;
    if (!t) return;
    const seconds = (t.ms / 1000).toFixed(1);
    this.log(
      `[stt] ${t.count} clip${t.count === 1 ? '' : 's'} too quiet, not sent (${seconds}s in all, loudest peak ${t.peakDb}dB)`,
    );
  }
}
