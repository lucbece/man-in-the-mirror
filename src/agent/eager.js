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
      const ok = await transcribeUtterance(utterance, stt);
      if (ok && utterance.text) {
        this.completed += 1;
        this.emit('transcribed', utterance);
      }
    } catch (err) {
      if (err.fatal) this.fail(err);
    }
  }

  fail(err) {
    this.fatalError = err;
    this.queue = [];
    console.warn(`[eager${this.label}] stopping: ${err.message}`);
    this.emit('failed', err);
  }

  /** Clear the fatal state so a fixed key or provider takes effect. */
  reset() {
    this.fatalError = null;
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
      error: this.fatalError?.message ?? null,
    };
  }
}
