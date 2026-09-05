/**
 * Playing several pieces of audio as one continuous utterance.
 *
 * The reply is synthesised sentence by sentence so the bot can start talking
 * before the model has finished thinking. That only sounds like one answer if
 * the pieces play back to back — a gap between them reads as the bot having
 * finished, and people start talking over it.
 *
 * Discord's player holds one resource at a time, so this queues them and
 * starts the next the moment the current one goes idle.
 */
import { AudioPlayerStatus } from '@discordjs/voice';

export class SpeechQueue {
  /**
   * `muted` is asked, per piece, whether the room wants to hear anything at
   * all — music mode. It is a function rather than a flag because the answer
   * can change while a reply is being rendered: the turn that is told to talk
   * again has to be able to say so out loud.
   */
  constructor(player, muted = () => false) {
    this.player = player;
    this.muted = muted;
    this.pending = [];
    this.playing = false;
    this.ended = false; // no more pieces will be pushed
    this.cancelled = false;
    this.spoken = [];
    /** When the first piece reached the player: the moment the room heard something. */
    this.startedAt = null;

    this.finished = new Promise((resolve) => {
      this.resolve = resolve;
    });

    this.onIdle = () => {
      this.playing = false;
      this.#advance();
    };
    this.player.on(AudioPlayerStatus.Idle, this.onIdle);
  }

  /** Queue a piece. `text` is kept only so callers can report what was said. */
  push(resource, text) {
    if (this.cancelled || this.ended) return;
    // Music mode drops it here, the last place before the audio, because this
    // is the one door every spoken thing goes through — an answer, a filler
    // clip, a line before a tool. A check further up would only cover the
    // paths that existed when it was written.
    if (this.muted()) return;
    this.pending.push(resource);
    if (text) this.spoken.push(text);
    this.#advance();
  }

  /** No further pieces are coming; finish once the queue drains. */
  end() {
    this.ended = true;
    this.#advance();
  }

  /** Stop now and abandon whatever is queued — backs "stop talking". */
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.pending = [];
    this.#detach();
    this.resolve({ cancelled: true, spoken: this.spoken });
  }

  #advance() {
    if (this.cancelled || this.playing) return;

    const next = this.pending.shift();
    if (next) {
      this.playing = true;
      try {
        this.player.play(next);
        this.startedAt ??= Date.now();
      } catch (err) {
        // A bad resource must not wedge the rest of the sentence.
        console.warn(`[speech] could not play a piece: ${err.message}`);
        this.playing = false;
        this.#advance();
      }
      return;
    }

    // Nothing queued. Done only if nothing more is coming — otherwise wait,
    // because the next sentence is still being synthesised.
    if (this.ended) {
      this.#detach();
      this.resolve({ cancelled: false, spoken: this.spoken });
    }
  }

  #detach() {
    this.player.off(AudioPlayerStatus.Idle, this.onIdle);
  }
}
