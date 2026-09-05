/**
 * Deadlines for the requests on the answer path, and a tally of the ones missed.
 *
 * One hung transcription request held the whole channel for 50 s and one
 * agent turn for 43 s; nothing on the path had a limit shorter than the two
 * minutes that end an agent session. Each request now gets a deadline for its
 * first sign of life, one retry, and a count per stage that the `[latency]`
 * line prints, so a change that trades speed for failures is visible.
 */

export class DeadlineError extends Error {
  constructor(stage, ms) {
    super(`${stage} gave no answer in ${(ms / 1000).toFixed(1)}s`);
    this.name = 'DeadlineError';
    this.stage = stage;
    this.ms = ms;
  }
}

/** Timeouts per stage since the last answer line took them. */
let tally = {};

export function noteTimeout(stage) {
  tally[stage] = (tally[stage] ?? 0) + 1;
}

/** The tally so far, reset for the next answer. Empty when nothing timed out. */
export function takeTimeouts() {
  const taken = tally;
  tally = {};
  return Object.keys(taken).length ? taken : undefined;
}

/**
 * Run `attempt(signal, arrived)` with `ms` to show its first sign of life.
 *
 * `arrived()` is for the caller to say the deadline is met — headers in, first
 * content block seen — after which the request may take as long as it needs.
 * Not calling it means the whole request has to finish in time. A miss is
 * counted, and tried once more when `retries` allows; a second miss throws
 * {@link DeadlineError}. Any other failure is the caller's and passes through.
 */
export async function withDeadline(stage, ms, attempt, { retries = 1 } = {}) {
  for (let tries = 0; ; tries += 1) {
    const controller = new AbortController();
    let met = false;
    const timer = setTimeout(() => {
      if (!met) controller.abort(new DeadlineError(stage, ms));
    }, ms);
    const arrived = () => {
      met = true;
      clearTimeout(timer);
    };
    try {
      return await attempt(controller.signal, arrived);
    } catch (err) {
      const missed = controller.signal.aborted && !met;
      if (!missed) throw err;
      noteTimeout(stage);
      if (tries >= retries) throw controller.signal.reason;
      console.warn(`[${stage}] no answer in ${(ms / 1000).toFixed(1)}s — trying once more`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Seconds of audio in a 16-bit PCM WAV buffer, read from its own header. */
export function wavSeconds(wav) {
  const byteRate = wav.length >= 32 ? wav.readUInt32LE(28) : 0;
  return byteRate > 0 ? Math.max(0, wav.length - 44) / byteRate : 0;
}

/** The STT deadline: 3 s plus 1 s per 5 s of clip, so a long clip is not cut twice. */
export function sttDeadlineMs(wav) {
  return 3000 + Math.round((wavSeconds(wav) / 5) * 1000);
}

export const TTS_FIRST_BYTE_MS = 3000;
export const FAST_FIRST_BLOCK_MS = 5000;
export const AGENT_FIRST_BLOCK_MS = 15_000;
