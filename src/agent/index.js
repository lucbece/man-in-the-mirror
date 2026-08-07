/**
 * The full round trip: hear → transcribe → think and speak, overlapping.
 *
 * Each stage is timed and reported, because when this feels slow you need to
 * know *which* stage was slow — they have completely different fixes. The one
 * that matters most is `first words at`, since that's when a listener stops
 * wondering whether the thing is broken.
 */
import { createBrain, clampForSpeech, BrainError, MAX_SPOKEN_CHARS } from './brain.js';
import { takePendingLeave } from './tools/index.js';
import { recordAnswer } from './answers.js';
import { createTts, toAudioResource } from './tts.js';
import { guessLanguage, takeFiller } from './filler.js';
import { formatTranscript, transcribeBuffer } from './stt.js';

/**
 * Longest a reply may spend playing before it is cut off.
 *
 * `ask()` releases the one-at-a-time guard for a guild only after playback
 * finishes, so a queue that never drains — a stalled stream, a player that
 * never reports going idle — leaves that guild answering "still working on the
 * last one" to everything, until the process restarts. Generous enough that no
 * real answer reaches it: the spoken length is capped at MAX_SPOKEN_CHARS,
 * which is about twenty-five seconds of speech.
 */
const SPEAK_TIMEOUT_MS = 60_000;

/**
 * Wait for the reply to finish playing, but not forever.
 *
 * Returns rather than throwing on timeout: by then most of the answer has been
 * spoken, so the caller's job is to report it, not to treat it as a failure.
 */
export async function finishSpeaking(speech, timeoutMs = SPEAK_TIMEOUT_MS) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `[agent] playback did not finish within ${timeoutMs / 1000}s — cutting it off`,
      );
      speech.cancel();
      resolve(true);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return (await Promise.race([speech.finished.then(() => false), guard])) === true;
  } finally {
    clearTimeout(timer);
  }
}

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
export async function ask(session, { question, askedBy, askedById, stoppedAt }, deps = {}) {
  // The collaborators are injectable, defaulting to the real ones, purely so
  // this function can be tested. It is where the brain, the synthesiser, the
  // filler clips and the speech queue meet — and it had no coverage at all,
  // which is where two of three defects found by reading the code were living.
  // The alternative was Node's module mocking, which is experimental and would
  // put a warning on every test run.
  const {
    createBrain: makeBrain = createBrain,
    createTts: makeTts = createTts,
    takeFiller: getFiller = takeFiller,
    toAudioResource: toResource = toAudioResource,
    transcribeBuffer: transcribe = transcribeBuffer,
    formatTranscript: format = formatTranscript,
  } = deps;

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
      await transcribe(session.receiver.buffer);
      utterances = session.receiver.buffer.recent();
      transcript = format(utterances);
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
    const brain = makeBrain({ guildId: session.guildId });
    const tts = makeTts();
    const speech = session.startSpeech();

    let budget = MAX_SPOKEN_CHARS;
    let cutOff = false;
    // Which tools this answer reached for. The set is what tells the routing
    // question apart from a guess: a turn that used nothing could have been
    // answered by anything.
    const toolsUsed = [];

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
        const filler = getFiller(guessLanguage(question), 'waiting');
        if (filler) {
          speech.push(toResource(filler.audio), null);
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
          speech.push(toResource(audio), clean);
          nudge();
        })
        .catch((err) => {
          // Counted as well as logged: a reply that renders nothing at all
          // otherwise surfaces as "the model returned nothing to say", which
          // points at the wrong stage entirely.
          timings.renderFailures = (timings.renderFailures ?? 0) + 1;
          console.warn(`[speech] could not render: ${err.message}`);
        });
    };

    try {
      // The return value is the whole reply, but everything sayable has
      // already gone out through onSentence by the time it resolves.
      await brain.answer(
        { transcript, utterances, question, askedBy, askedById },
        {
          onSentence: say,
          onToolUse: (name) => {
            if (!toolsUsed.includes(name)) toolsUsed.push(name);
          },
          // Only reached when nothing has been said yet — a canned clip on top
          // of the model's own words would be two fillers in a row.
          onSearchStart: () => {
            timings.searchedAtMs = Date.now() - t1;
            const filler = getFiller(guessLanguage(question));
            if (!filler) return;
            speech.push(toResource(filler.audio), null);
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

    timings.cutOffPlayback = await finishSpeaking(speech);
    timings.totalMs = Date.now() - started;
    // From the moment they stopped talking to the moment this pipeline began:
    // silence detection, transcription, the grace wait. The model's half has
    // always been measured; this is the half that never was.
    if (stoppedAt) timings.beforeAskMs = started - stoppedAt;

    recordAnswer({
      brain: brain.label,
      model: brain.model ?? null,
      tools: toolsUsed,
      escalated: Boolean(brain.escalated),
      timings,
    });

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
        (timings.waited ? ` · filled ${timings.waited} long silence(s)` : '') +
        (toolsUsed.length ? ` · tools: ${toolsUsed.join(', ')}` : ' · no tools') +
        (timings.beforeAskMs
          ? ` · ${(timings.beforeAskMs / 1000).toFixed(1)}s of that was before the model was asked`
          : ''),
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

export { SPEAK_TIMEOUT_MS };
