/**
 * The full round trip: hear → transcribe → think → speak.
 *
 * Each stage is timed and reported, because when this feels slow you need to
 * know *which* stage was slow — they have completely different fixes.
 */
import { AudioPlayerStatus, entersState } from '@discordjs/voice';

import { createBrain, clampForSpeech, BrainError } from './brain.js';
import { createTts, toAudioResource } from './tts.js';
import { guessLanguage, takeFiller } from './filler.js';
import { formatTranscript, transcribeBuffer } from './stt.js';

/** Guard against a stuck stage wedging the session forever. */
const SPEAK_TIMEOUT_MS = 60_000;

export class AgentBusyError extends Error {}

/** Guilds with a request in flight — one conversation at a time per channel. */
const inFlight = new Set();

/**
 * Answer a question out loud in the session's channel.
 *
 * Returns the timings and the text that was spoken, so callers can show the
 * user what happened rather than just "done".
 */
export async function ask(session, { question, askedBy }) {
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
    if (session.agentEnabled) {
      await transcribeBuffer(session.receiver.buffer);
      transcript = formatTranscript(session.receiver.buffer.recent());
    }
    timings.transcribeMs = Date.now() - t0;

    // 2. Think. If it goes off to search, fill the silence it just created —
    //    but only then, and only with audio rendered ahead of time. Anything
    //    else would lengthen the wait to announce the wait.
    const t1 = Date.now();
    const brain = createBrain();
    const raw = await brain.answer(
      { transcript, question, askedBy },
      {
        onSearchStart: () => {
          timings.searchedAtMs = Date.now() - t1;
          const filler = takeFiller(guessLanguage(question));
          if (!filler) return;
          try {
            session.player.play(toAudioResource(filler.audio));
            timings.filler = filler.line;
          } catch (err) {
            console.warn(`[filler] could not play: ${err.message}`);
          }
        },
      },
    );
    timings.thinkMs = Date.now() - t1;

    const spoken = clampForSpeech(raw);
    if (!spoken) throw new BrainError('The model returned nothing to say.');

    // 3. Speak. Streamed rather than buffered: playback starts on the first
    //    bytes instead of waiting for the whole file, which is about a second
    //    of silence removed.
    const t2 = Date.now();
    const tts = createTts();
    const audio = await tts.synthesizeStream(spoken);
    timings.speakMs = Date.now() - t2;

    // If a filler is still playing, let it finish its sentence — cutting it
    // off is more jarring than the half-second it costs to wait.
    if (timings.filler && session.speaking) {
      await entersState(session.player, AudioPlayerStatus.Idle, 4_000).catch(() => {});
    }

    // Never talk over ourselves — a second answer starting mid-sentence is
    // worse than a slightly delayed one.
    session.player.stop(true);
    session.player.play(toAudioResource(audio));

    try {
      await entersState(session.player, AudioPlayerStatus.Playing, 5_000);
    } catch {
      throw new Error('Audio never started playing — check the ffmpeg install.');
    }

    timings.totalMs = Date.now() - started;
    console.log(
      `[agent] answered in ${(timings.totalMs / 1000).toFixed(1)}s ` +
        `(heard ${(timings.transcribeMs / 1000).toFixed(1)}s, ` +
        `thought ${(timings.thinkMs / 1000).toFixed(1)}s, ` +
        `voiced ${(timings.speakMs / 1000).toFixed(1)}s)` +
        (timings.filler
          ? ` · searched at ${(timings.searchedAtMs / 1000).toFixed(1)}s, said "${timings.filler}"`
          : ''),
    );
    console.log(`[agent]   via ${brain.label} → ${tts.label}`);

    return {
      spoken,
      truncated: spoken !== raw.trim(),
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
