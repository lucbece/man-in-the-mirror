/**
 * Transcribes utterances in the background, moments after they're spoken.
 *
 * The alternative — transcribing the whole buffer at the moment someone asks a
 * question — means three minutes of audio becomes text *while the person
 * waits*. That's structurally slow no matter how much it's parallelised.
 *
 * The trade is money: this pays for everything anyone says, not just what's in
 * the window when a question is asked. On local transcription that cost is
 * zero, which is where this design wants to end up.
 */
import { EventEmitter } from 'node:events';

import { createProvider, transcribeUtterance } from './stt.js';

/** Enough to keep up with a lively channel without opening a socket per person. */
const CONCURRENCY = 3;

export class EagerTranscriber extends EventEmitter {
  constructor({ label = '' } = {}) {
    super();
    this.label = label;
    this.queue = [];
    this.running = 0;
    this.stopped = false;
    /** Set when the provider says something unrecoverable — no point retrying. */
    this.fatalError = null;
    this.completed = 0;
    this.failures = 0;
  }

  push(utterance) {
    if (this.stopped || this.fatalError) return;
    this.queue.push(utterance);
    this.drain();
  }

  drain() {
    while (!this.stopped && !this.fatalError && this.running < CONCURRENCY) {
      const utterance = this.queue.shift();
      if (!utterance) return;

      this.running += 1;
      this.transcribe(utterance).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  async transcribe(utterance) {
    let stt;
    try {
      stt = createProvider();
    } catch (err) {
      // No key, or a provider that isn't wired up. Nothing will fix itself.
      this.fail(err);
      return;
    }

    try {
      const { spoken, failed } = await transcribeUtterance(utterance, stt);
      // Counted, not logged again. A local runtime that won't start, a model
      // that won't load, a binary that exits non-zero — all of it used to
      // vanish here and look from the outside like the bot simply not hearing
      // anything, which is the hardest possible thing to debug. It is reported
      // now, but by transcribeUtterance, which is where it happens; saying it
      // twice would just make the log harder to read.
      if (failed) this.failures += 1;
      if (spoken) {
        this.completed += 1;
        this.emit('transcribed', utterance);
      }
    } catch (err) {
      // Only fatal errors get this far — no key, no credit, a provider that
      // will fail identically on everything queued behind this.
      this.fail(err);
    }
  }

  fail(err) {
    this.fatalError = err;
    this.queue = [];
    console.warn(`[eager${this.label}] stopping: ${err.message}`);
    this.emit('failed', err);
  }

  /**
   * Clear the fatal state so a fixed key or a switched provider takes effect.
   *
   * Nothing called this for a long time, which made a fatal error permanent:
   * one bad key, or one run out of quota, stopped the queue for good, and
   * switching to local transcription in the panel changed nothing because the
   * old failure was still latched. From outside, the bot had simply gone deaf
   * and only a restart brought it back.
   */
  reset() {
    if (this.fatalError) {
      console.log(`[eager${this.label}] clearing the previous failure and listening again`);
    }
    this.fatalError = null;
    this.failures = 0;
  }

  stop() {
    this.stopped = true;
    this.queue = [];
  }

  status() {
    return {
      queued: this.queue.length,
      running: this.running,
      completed: this.completed,
      failures: this.failures,
      error: this.fatalError?.message ?? null,
    };
  }
}
