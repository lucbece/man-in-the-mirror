/**
 * A rolling, in-memory record of who said what, recently.
 *
 * Holds raw Opus packets — not text. Nothing here is transcribed until someone
 * actually asks the bot a question, which is the entire cost strategy: idle
 * listening is free, and you only pay for audio you're about to use.
 *
 * Nothing is ever written to disk. Utterances age out and are dropped.
 */

/** Hard ceiling so a stuck timer or a very chatty channel can't eat all the RAM. */
const MAX_BYTES = 64 * 1024 * 1024;

let nextId = 1;

export class Utterance {
  constructor({ userId, displayName, startedAt }) {
    this.id = nextId++;
    this.userId = userId;
    this.displayName = displayName;
    this.startedAt = startedAt;
    this.endedAt = null;
    this.packets = [];
    this.bytes = 0;
    /** Filled in lazily by the transcriber, then reused. */
    this.text = null;
  }

  push(packet) {
    this.packets.push(packet);
    this.bytes += packet.length;
  }

  /** Discord sends 20ms per Opus frame, so packet count is the duration. */
  get durationMs() {
    return this.packets.length * 20;
  }
}

/**
 * How long a typed line stays readable, whatever the audio window is.
 *
 * Longer than the rolling audio on purpose. Somebody types a line precisely
 * because it is the kind of string speech recognition destroys — a mod id, a
 * song title in a language nobody in the room speaks — and having to type it
 * again because they took two minutes to get to the question would defeat it.
 * It costs nothing to keep: a note holds no audio.
 */
export const TYPED_WINDOW_MS = 10 * 60 * 1000;

export class AudioBuffer {
  constructor({ windowSeconds = 180 } = {}) {
    this.windowSeconds = windowSeconds;
    this.utterances = [];
    this.bytes = 0;
  }

  setWindow(seconds, now = Date.now()) {
    this.windowSeconds = seconds;
    this.prune(now);
  }

  /**
   * Put a line into the conversation that nobody said out loud.
   *
   * Typed through a slash command, and read by the model exactly like a line
   * somebody spoke — same transcript, same attribution, same place in time.
   * It is not a question and it wakes nothing: the point is to be *context*
   * for whatever gets asked next. "Espejo, te escribí el nombre del tema,
   * ponelo."
   */
  note({ userId, displayName, text }, now = Date.now()) {
    const line = new Utterance({ userId, displayName, startedAt: now });
    line.endedAt = now;
    line.text = String(text ?? '').trim();
    line.typed = true;
    if (!line.text) return null;
    this.utterances.push(line);
    this.prune(now);
    return line;
  }

  /** `now` is injectable so the ageing behaviour can be tested deterministically. */
  add(utterance, now = Date.now()) {
    if (utterance.packets.length === 0) return;
    utterance.endedAt ??= now;
    this.utterances.push(utterance);
    this.bytes += utterance.bytes;
    this.prune(now);
  }

  /**
   * Drop anything older than the window. Also enforces the byte ceiling by
   * dropping oldest-first, so a runaway can't outgrow memory.
   */
  prune(now = Date.now()) {
    const cutoff = now - this.windowSeconds * 1000;
    let dropped = 0;

    const typedCutoff = now - TYPED_WINDOW_MS;

    while (this.utterances.length > 0) {
      const oldest = this.utterances[0];
      const tooOld =
        oldest.endedAt !== null && oldest.endedAt < (oldest.typed ? typedCutoff : cutoff);
      if (!tooOld && this.bytes <= MAX_BYTES) break;
      this.utterances.shift();
      this.bytes -= oldest.bytes;
      dropped += 1;
    }

    return dropped;
  }

  /** Everything still in the window, oldest first. */
  recent(now = Date.now()) {
    this.prune(now);
    return [...this.utterances].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The subset that still needs transcribing — what a request actually pays for. */
  untranscribed(now = Date.now()) {
    return this.recent(now).filter((u) => u.text === null);
  }

  stats(now = Date.now()) {
    const recent = this.recent(now);
    const speechMs = recent.reduce((sum, u) => sum + u.durationMs, 0);
    return {
      utterances: recent.length,
      speakers: new Set(recent.map((u) => u.userId)).size,
      speechSeconds: Math.round(speechMs / 1000),
      pendingUtterances: recent.filter((u) => u.text === null).length,
      bytes: this.bytes,
      windowSeconds: this.windowSeconds,
    };
  }

  /** Wipe everything. Backs `/mj deaf` and any "stop listening" control. */
  clear() {
    this.utterances = [];
    this.bytes = 0;
  }
}
