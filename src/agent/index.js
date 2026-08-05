/**
 * The full round trip: hear → transcribe → think and speak, overlapping.
 *
 * Each stage is timed and reported, because when this feels slow you need to
 * know *which* stage was slow — they have completely different fixes. The one
 * that matters most is `first words at`, since that's when a listener stops
 * wondering whether the thing is broken.
 */
import { createBrain, clampForSpeech, BrainError, MAX_SPOKEN_CHARS } from './brain.js';
import { takePendingLeave } from './agent-brain.js';
import { createTts, toAudioResource } from './tts.js';
import { guessLanguage, takeFiller } from './filler.js';
import { formatTranscript, transcribeBuffer } from './stt.js';

/** Guard against a stuck stage wedging the session forever. */
const SPEAK_TIMEOUT_MS = 60_000;

/**
 * How long a silence has to last, once the bot has started talking, before it
 * says something to fill it.
 *
 * Long enough that a normal answer never reaches it — the gap between two
 * sentences is a second or two — and short enough that a slow tool doesn't
 * leave the channel wondering whether the thing crashed.
 */
const QUIET_MS = 7_000;

export class AgentBusyError extends Error {}

/** Guilds with a request in flight — one conversation at a time per channel. */
const inFlight = new Set();

/**
 * Answer a question out loud in the session's channel.
 *
 * Returns the timings and the text that was spoken, so callers can show the
 * user what happened rather than just "done".
 */
export async function ask(session, { question, askedBy, askedById }) {
  if (inFlight.has(session.guildId)) {
    throw new AgentBusyError('Still working on the last one.');
  }
  inFlight.add(session.guildId);

  const timings = {};
  const started = Date.now();

  try {
    // 1. Transcribe whatever context isn't already text. Cached utterances
    //    cost nothing, so follow-up questions are much cheaper than the first.
    const t0 = Date.now();
    let transcript = '';
    let utterances = [];
    if (session.agentEnabled) {
      await transcribeBuffer(session.receiver.buffer);
      utterances = session.receiver.buffer.recent();
      transcript = formatTranscript(utterances);
    }
    timings.transcribeMs = Date.now() - t0;

    // 2 and 3, at the same time. The reply is spoken sentence by sentence as
    //    the model produces it, rather than after it finishes: measured, the
    //    first sentence exists about a second before the last one does, and
    //    synthesising one sentence beats synthesising four by half a second
    //    again.
    //
    //    What keeps it seamless after that is that speech is slower than
    //    synthesis — a sentence takes two or three seconds to say and under
    //    one to render, so the queue stays ahead. The only gap is the first.
    const t1 = Date.now();
    const brain = createBrain({ guildId: session.guildId });
    const tts = createTts();
    const speech = session.startSpeech();

    let budget = MAX_SPOKEN_CHARS;
    let cutOff = false;

    // If the silence drags on after we've already said something, say
    // something else. Not announced up front: most tool calls come back
    // quickly, so warning about a wait that usually doesn't happen makes the
    // bot sound slow when it isn't. This only speaks once the wait is real.
    let quietTimer = null;
    let finishedThinking = false;
    const nudge = () => {
      clearTimeout(quietTimer);
      if (finishedThinking) return;
      quietTimer = setTimeout(() => {
        const filler = takeFiller(guessLanguage(question), 'waiting');
        if (filler) {
          speech.push(toAudioResource(filler.audio), null);
          timings.waited = (timings.waited ?? 0) + 1;
        }
        nudge(); // and again if it keeps dragging
      }, QUIET_MS);
      quietTimer.unref?.();
    };
    // Synthesis requests are chained so pieces reach the queue in the order
    // they were said. Each resolves when the response starts, not when it
    // finishes, so this costs nothing in wall clock.
    let rendering = Promise.resolve();

    const say = (text) => {
      const clean = clampForSpeech(text, Math.max(0, budget));
      if (!clean || budget <= 0) {
        cutOff ||= Boolean(text.trim());
        return;
      }
      budget -= clean.length;
      rendering = rendering
        .then(async () => {
          const audio = await tts.synthesizeStream(clean);
          timings.firstAudioMs ??= Date.now() - t1;
          speech.push(toAudioResource(audio), clean);
          nudge();
        })
        .catch((err) => console.warn(`[speech] could not render: ${err.message}`));
    };

    try {
      // The return value is the whole reply, but everything sayable has
      // already gone out through onSentence by the time it resolves.
      await brain.answer(
        { transcript, utterances, question, askedBy, askedById },
        {
          onSentence: say,
          // Only reached when nothing has been said yet — a canned clip on top
          // of the model's own words would be two fillers in a row.
          onSearchStart: () => {
            timings.searchedAtMs = Date.now() - t1;
            const filler = takeFiller(guessLanguage(question));
            if (!filler) return;
            speech.push(toAudioResource(filler.audio), null);
            timings.filler = filler.line;
            nudge();
          },
        },
      );
    } finally {
      finishedThinking = true;
      clearTimeout(quietTimer);
      // Whatever was already said still has to finish playing, even if the
      // model failed partway — a half answer beats a sentence cut in two.
      await rendering;
      speech.end();
    }
    timings.thinkMs = Date.now() - t1;

    const spoken = speech.spoken.join(' ').trim();
    if (!spoken) throw new BrainError('The model returned nothing to say.');

    await speech.finished;
    timings.totalMs = Date.now() - started;

    // Asked to disconnect: now, with the goodbye already said. Doing it inside
    // the tool call would tear down the agent session that was still running
    // that very call.
    if (takePendingLeave(session.guildId)) {
      const { sessionManager } = await import('../voice/manager.js');
      sessionManager.leave(session.guildId);
      console.log('[agent] left the channel, as asked');
    }

    console.log(
      `[agent] answered in ${(timings.totalMs / 1000).toFixed(1)}s ` +
        `(heard ${(timings.transcribeMs / 1000).toFixed(1)}s, ` +
        `first words at ${(timings.firstAudioMs / 1000).toFixed(1)}s, ` +
        `thought through ${(timings.thinkMs / 1000).toFixed(1)}s)` +
        (timings.filler
          ? ` · searched at ${(timings.searchedAtMs / 1000).toFixed(1)}s, said "${timings.filler}"`
          : '') +
        (timings.waited ? ` · filled ${timings.waited} long silence(s)` : ''),
    );
    console.log(`[agent]   via ${brain.label} → ${tts.label}`);

    return {
      spoken,
      truncated: cutOff,
      timings,
      brain: brain.label,
      voice: tts.label,
    };
  } finally {
    inFlight.delete(session.guildId);
  }
}

/** Whether a guild currently has a request in flight. */
export function isBusy(guildId) {
  return inFlight.has(guildId);
}

export { SPEAK_TIMEOUT_MS };
