/**
 * Speech to text.
 *
 * One interface, swappable implementations. Cloud today; local whisper.cpp is
 * a second implementation of this same shape, not a redesign — which matters,
 * because on a machine with a real GPU local is strictly better (same model,
 * no per-minute cost, audio never leaves the box).
 */
import { config } from '../config.js';
import { detectAddress } from './wake.js';
import { decodeToMono16k, pcmToWav } from './audio.js';
import { withDeadline, sttDeadlineMs, DeadlineError } from './deadline.js';
import { measureEnergy, tooQuiet } from './energy.js';
import { ClipLog } from './clip-log.js';
import { MODELS, ensureModel, ensureWhisper, transcribeWav } from './whisper.js';

/** Below this an "utterance" is a cough or a mic bump. Not worth a request. */
const MIN_UTTERANCE_MS = 300;

/**
 * The deadline for the whisper-1 confirmation of a lone name, independent of
 * the primary model's own deadline.
 *
 * This used to inherit `sttDeadlineMs`, retries included — a confirmation
 * that hung cost two full ~4.2s deadlines in series, on the critical path of
 * the very utterance that wakes the bot (8-11s wakes in production, traced to
 * `[stt] second opinion failed: stt gave no answer in 4.2s`). A confirmation
 * must never cost more than the utterance it confirms: on timeout the primary
 * transcript is trusted as-is, so there is nothing to gain from waiting as
 * long as the real request gets.
 */
export const SECOND_OPINION_MS = 2000;

/**
 * Whisper invents these when handed near-silence — a well-known artefact of
 * training on captioned video. They pollute the transcript the model reads and
 * are indistinguishable from someone actually saying "thanks", so only discard
 * them on short clips where nothing else was said.
 */
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'gracias',
  'muchas gracias',
  'suscribete al canal',
  'subtitulos realizados por la comunidad de amara org',
  'amara org',
]);

/** Short clips whose entire content is a stock phrase are almost certainly noise. */
const HALLUCINATION_MAX_MS = 2_500;

/**
 * Boilerplate distinctive enough to reject wherever it appears, at any length.
 *
 * These come out of the subtitle corpora Whisper was trained on, and the first
 * one turned up in a live channel word for word: "este es el canal de
 * subt\u00edtulos en espa\u00f1ol de la Iglesia de Jesucristo de los santos de los
 * \u00faltimos d\u00edas", twice over, with nobody speaking. Unlike "gracias", nobody in
 * a Discord call says any of these, so matching them anywhere in the text is
 * safe where the short-phrase list has to be exact.
 */
const BOILERPLATE = [
  'canal de subtitulos',
  'iglesia de jesucristo de los santos',
  'subtitulos realizados por',
  'subtitulos por la comunidad',
  'amara org',
  'subtitled by',
  'subtitles by the amara',
  'www ted com',
  'subscribe to my channel',
  'no olvides suscribirte',
  'mas videos como este',
];

/**
 * Fastest anyone speaks, in words per second, with room to spare.
 *
 * Conversation runs two to three; an auctioneer reaches six. Text arriving
 * faster than this did not come from the audio it claims to describe \u2014 which
 * is what a hallucination on near-silence looks like from here, without
 * needing to recognise the phrase.
 */
const MAX_WORDS_PER_SECOND = 7;

function normaliseForMatch(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Did the model say something nobody said?
 *
 * Three signals, in order of how general they are. The last one is the phrase
 * list, which only ever catches what has already been seen; the first two
 * catch boilerplate nobody has reported yet.
 */
function looksHallucinated(text, durationMs) {
  const bare = normaliseForMatch(text);
  if (!bare) return false;

  // 1. More words than the clip has room for.
  const words = bare.split(' ').length;
  if (durationMs > 0 && words / (durationMs / 1000) > MAX_WORDS_PER_SECOND) return true;

  // 2. The same sentence over and over. Whisper loops when it has nothing to
  //    work with, and people repeat themselves in different words, not in
  //    identical ones.
  const sentences = text
    .split(/[.!?\u2026]+/)
    .map((s) => normaliseForMatch(s))
    .filter((s) => s.split(' ').length >= 4);
  if (sentences.length >= 2 && new Set(sentences).size === 1) return true;

  // 3. Known subtitle boilerplate, anywhere in the text.
  if (BOILERPLATE.some((phrase) => bare.includes(phrase))) return true;

  // 4. A short clip that is nothing but a stock phrase.
  if (durationMs <= HALLUCINATION_MAX_MS && HALLUCINATIONS.has(bare)) return true;

  return false;
}

/**
 * Parallel requests.
 *
 * Each utterance is its own round trip, so with a few minutes of a four-person
 * conversation buffered this is the difference between three seconds and
 * twenty. Whisper's rate limits are per-minute and generous; the ceiling here
 * is really how many sockets we want open at once.
 */
const CONCURRENCY = 12;

/**
 * `fatal` means every subsequent request will fail the same way — bad key, no
 * credit, wrong provider. There's no point burning through the rest of the
 * buffer, and no point discarding the audio: fix the cause and it's all still
 * there to transcribe.
 */
class SttError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal;
  }
}

class OpenAiWhisper {
  constructor({ apiKey, model, fetch = globalThis.fetch }) {
    if (!apiKey) throw new SttError('No OpenAI API key configured.');
    this.apiKey = apiKey;
    this.model = model || 'whisper-1';
    /** Injectable so a hung request can be tested without a real deadline. */
    this.fetch = fetch;
  }

  get label() {
    return `OpenAI ${this.model}`;
  }

  /**
   * `deadlineMs`, `retries` and `stage` default to the size-based deadline,
   * one retry, and the 'stt' tally — the shape every existing call already
   * has. A caller that needs a shorter, single-shot deadline under its own
   * stage name (the whisper-1 confirmation call, see `SECOND_OPINION_MS`)
   * passes them explicitly.
   */
  async transcribe(wav, { language, prompt, deadlineMs, retries, stage = 'stt' } = {}) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.model);
    // No `language` pin by default: this channel code-switches between Spanish
    // and English mid-sentence, and forcing one makes the other much worse.
    if (language) form.append('language', language);

    // Bias the decoder toward the bot's name. Without this, "mirror" spoken in
    // a Spanish sentence came back as "mi herrero", "Mirad" and "mirra" —
    // Whisper writing an unfamiliar English word as the nearest Spanish thing
    // it knows. A prompt containing the name makes it a word Whisper expects.
    if (prompt) form.append('prompt', prompt);

    // The whole request has to finish in time: a transcript arrives in one
    // piece, so there is no first byte to wait for. One request hanging here
    // once held the channel for 50 s.
    const res = await withDeadline(
      stage,
      deadlineMs ?? sttDeadlineMs(wav),
      (signal) =>
        this.fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal,
        }).then(async (r) => {
          // Read inside the deadline too: the body is the transcript.
          if (r.ok) r.parsed = await r.json();
          return r;
        }),
      { retries },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let code = '';
      try {
        code = JSON.parse(detail)?.error?.code ?? '';
      } catch {
        /* not JSON */
      }

      // Out of credit and bad keys are worth naming plainly — the raw API text
      // sends people hunting for a problem in their audio.
      if (code === 'insufficient_quota') {
        throw new SttError(
          'Your OpenAI account has no credit. Add billing at platform.openai.com → Settings → Billing.',
          { fatal: true },
        );
      }
      if (res.status === 401) {
        throw new SttError('OpenAI rejected the API key.', { fatal: true });
      }

      // A plain 429 is rate limiting — transient, so don't consume the audio.
      throw new SttError(
        `OpenAI returned ${res.status}: ${detail.replace(/\s+/g, ' ').slice(0, 160)}`,
        { fatal: res.status === 429 },
      );
    }

    return (res.parsed?.text ?? '').trim();
  }
}

/**
 * A hint passed to the recogniser so the bot's own name survives transcription.
 *
 * Whisper leans on this to decide between words that sound alike, which is
 * exactly the problem: an English name inside Spanish speech gets rewritten to
 * whatever Spanish word is closest. Naming it up front largely stops that.
 */
export function namePrompt() {
  const names = String(config.get('agentNames') ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  // Bare names, not a sentence.
  //
  // This used to read "Conversación en un canal de voz con un asistente
  // llamado mirror o espejo." — and Whisper handed it straight back whenever
  // it got silence, which is what a prompt is *for*: it conditions what the
  // model expects to hear. A grammatical sentence is a template it can emit
  // happily. Worse, the echo contained the bot's name, so the bot woke itself
  // up on a line nobody said. A word list still biases the spelling and is
  // far less quotable, and echoesPrompt below catches it when it comes back
  // anyway.
  return names.join(', ');
}

/**
 * Below this share of loud windows, a clip that came back as nothing but the
 * bot's name was noise the model named.
 *
 * 0.1, down from 0.25: measured over a day, a quarter of the clips people
 * actually spoke into were under 34% active and a tenth under 20%, so the
 * first threshold was throwing away real calls said quietly or from a
 * distance. The noise that the guard exists for measured 0% active on the
 * bench, so the bar can sit low.
 */
export const NOISE_ACTIVE_RATIO = 0.1;

/**
 * Only the GPT-4o transcription models answer noise with the bot's name;
 * whisper-1 answers it with subtitle boilerplate the lists already catch.
 * Whisper-1 had the guard for a day and lost real calls to it.
 */
export const namesNoise = (model) => /^gpt-4o/.test(String(model ?? ''));

/**
 * Is the text nothing but the bot's names?
 *
 * The one shape a GPT-4o transcriber gives noise: not a sentence with the
 * name in it, the name and nothing else.
 */
export function onlyTheNames(text, prompt) {
  const words = normaliseForMatch(text).split(' ').filter(Boolean);
  if (!words.length) return false;
  const names = new Set(normaliseForMatch(prompt ?? '').split(' ').filter(Boolean));
  return words.every((w) => names.has(w));
}

/**
 * A second model's opinion on a clip the first said was just the name.
 *
 * Energy cannot tell a loud breath from a quietly spoken name: measured over
 * a day, a twentieth of the short clips people really spoke into peaked under
 * -34 dB, which is where the bench's breath sat. Two models do not
 * hallucinate the same thing, though: whisper-1 answers noise with subtitle
 * boilerplate, never with the name. So a lone name from a GPT-4o model is
 * confirmed by asking whisper-1 about the same audio, and kept only if it
 * heard something near a name too. In production it dropped 905 of the 952
 * lone names gpt-4o-transcribe produced in a day.
 *
 * Asking the same model again without the prompt was measured and rejected:
 * without it gpt-4o-transcribe hears a lone real "espejo" 2 times in 14, so
 * that check would have thrown away the calls it exists to protect, and with
 * them the "espejo… [pause] ¿qué hora es?" pattern. The 47 lone names a day
 * that survive this check are handled where they can be told apart — by
 * whether a question follows (see fireWake in voice/session.js).
 */
let secondOpinionProvider = null;
export function secondOpinionFor(stt) {
  if (stt?.constructor?.name !== 'OpenAiWhisper' || stt.model === 'whisper-1') return null;
  if (!secondOpinionProvider || secondOpinionProvider.apiKey !== stt.apiKey) {
    secondOpinionProvider = new OpenAiWhisper({ apiKey: stt.apiKey, model: 'whisper-1' });
  }
  return secondOpinionProvider;
}

/** Does a transcript carry anything that could be one of the names? */
export function hearsAName(text, names) {
  const { matched, closest } = detectAddress(text, names);
  return matched || (closest?.score ?? 0) >= 0.5;
}

/**
 * Did the model name the bot because the prompt told it to expect the name?
 *
 * gpt-4o-transcribe, given the names as a prompt, answers a clip of breath or
 * keyboard with "espejo" — a lone name, which `echoesPrompt` must let through
 * because a lone name is someone calling the bot. The clip's own energy tells
 * the two apart: a person saying the name is loud for a good part of the
 * clip, noise the model dressed up as a word is not.
 */
export function namedByNoise(text, prompt, energy) {
  if (!energy || energy.activeRatio >= NOISE_ACTIVE_RATIO) return false;
  const words = normaliseForMatch(text).split(' ').filter(Boolean);
  if (!words.length) return false;
  const names = new Set(normaliseForMatch(prompt ?? '').split(' ').filter(Boolean));
  return words.every((w) => names.has(w));
}

/**
 * Did the model just hand our own prompt back?
 *
 * Whisper conditions on the prompt, so on silence it will reproduce it — and
 * since the prompt is the bot's names, the echo reads as someone calling the
 * bot. It has to be discarded before anything else looks at the text.
 */
export function echoesPrompt(text, prompt) {
  const said = normaliseForMatch(text);
  const asked = normaliseForMatch(prompt ?? '');
  if (!said || !asked) return false;
  if (said === asked) return true;

  const promptWords = asked.split(' ');
  const words = said.split(' ');

  // A prompt that is just the names can only be an echo if it comes back
  // whole. One name on its own is somebody calling the bot — the entire point
  // of the thing — so that must never be mistaken for an echo.
  if (promptWords.length <= 4) {
    return (
      promptWords.every((w) => words.includes(w)) && words.length <= promptWords.length + 1
    );
  }

  // A longer prompt: mostly its words and little else, at about its length.
  if (words.length > promptWords.length + 4) return false;
  const set = new Set(promptWords);
  const shared = words.filter((w) => set.has(w)).length;
  return shared / words.length >= 0.7;
}

/**
 * Transcription on this machine, via whisper.cpp.
 *
 * Same model family the API runs, so quality is a hardware question rather
 * than a quality one: with a GPU this is both faster and free, without one it
 * is slower than the network round trip it replaces.
 */
class LocalWhisper {
  constructor({ model }) {
    this.model = MODELS[model] ? model : 'ggml-base';
    this.ready = null;
    this.logged = 0;
  }

  get label() {
    return `whisper.cpp ${this.model} (local)`;
  }

  /** Fetch binary and model on first use, once per process. */
  async prepare() {
    this.ready ??= (async () => {
      const started = Date.now();
      console.log(`[whisper] preparing ${this.model}…`);
      const binary = await ensureWhisper();
      const model = await ensureModel(this.model);
      console.log(
        `[whisper] ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ${this.model}`,
      );
      return { binary, model };
    })();
    return this.ready;
  }

  async transcribe(wav) {
    let binary;
    let model;
    const started = Date.now();
    try {
      ({ binary, model } = await this.prepare());
    } catch (err) {
      // Setup failing is not this clip's fault. Mark it fatal so the audio is
      // kept rather than consumed — the first run downloads hundreds of
      // megabytes, and everything said meanwhile would otherwise be lost.
      this.ready = null; // let the next attempt retry
      throw new SttError(`whisper.cpp no está listo: ${err.message}`, { fatal: true });
    }
    // No language pin: this channel code-switches mid-sentence, and forcing
    // one makes the other markedly worse.
    const text = await transcribeWav(wav, { binary, model, language: 'auto' });
    // First few are worth seeing: this is where "is local actually faster?"
    // gets answered on whatever machine it's running on.
    if (this.logged < 3) {
      this.logged += 1;
      console.log(
        `[whisper] transcribed in ${((Date.now() - started) / 1000).toFixed(2)}s (local)`,
      );
    }
    return text;
  }
}

/**
 * One provider per configuration, reused.
 *
 * Rebuilt only when the relevant settings change. Local providers hold a
 * downloaded runtime behind them, so handing every utterance its own instance
 * meant every utterance starting its own download.
 */
let cached = null;
let cachedKey = '';

export function createProvider() {
  const key = [
    config.get('sttProvider'),
    config.get('sttLocalModel'),
    config.get('sttModel'),
    config.get('openaiApiKey').slice(0, 8),
  ].join('|');

  if (cached && cachedKey === key) return cached;
  cached = buildProvider();
  cachedKey = key;
  return cached;
}

function buildProvider() {
  if (config.get('sttProvider') === 'local') {
    return new LocalWhisper({ model: config.get('sttLocalModel') });
  }
  return new OpenAiWhisper({ apiKey: config.get('openaiApiKey'), model: config.get('sttModel') });
}

/**
 * One in-flight transcription per utterance, so two callers share one request.
 *
 * Both entry points check `text !== null` before their `await`, and there are
 * two of them running concurrently by design: the eager queue picks an
 * utterance up moments after it is spoken, and `transcribeBuffer` sweeps the
 * window the instant a question arrives. An utterance cut in that gap passed
 * both checks, was sent twice, and was billed twice — and whichever reply
 * landed last won, which is a coin toss over which filtering ran.
 *
 * A `WeakMap` rather than a `Map`: the key is an utterance that the buffer
 * will drop on its own schedule, and nothing here should be the reason it
 * stays in memory.
 */
const inFlight = new WeakMap();

/**
 * Transcribe one utterance in place.
 *
 * Returns `{ spoken, failed }` — three outcomes that a boolean was quietly
 * conflating: it now has usable text, it came back empty or was discarded as
 * junk, or the request failed. The callers report the last of those to a
 * person, so it has to survive the trip.
 *
 * This is the only place transcription happens. That was the intent before —
 * an older version of this comment claimed it — but `transcribeBuffer` kept
 * its own copy of the logic, and the copy had lost the prompt-echo check. The
 * result was a bot that discarded Whisper repeating its own name back on one
 * path and answered it on the other.
 */
export function transcribeUtterance(utterance, stt) {
  if (utterance.text !== null) return Promise.resolve({ spoken: Boolean(utterance.text), failed: false });

  const existing = inFlight.get(utterance);
  // Whoever asked first is already doing it, with a provider built from the
  // same config. Waiting for that is strictly better than starting a second.
  if (existing) return existing;

  const run = runTranscription(utterance, stt).finally(() => inFlight.delete(utterance));
  inFlight.set(utterance, run);
  return run;
}

/** One tally for the process: clips from every channel land in one log. */
const clipLog = new ClipLog();

/**
 * Decode and measure a clip, and drop it if it was never loud enough to be a
 * voice. The numbers are the only thing known about a clip before paying for
 * it (see energy.js for the threshold), and they are what the eager queue
 * sorts by, so this runs once, at push time, and the transcription reuses
 * the decoded audio.
 *
 * Returns the energy of a clip worth sending, `null` for one that was not;
 * a dropped clip has its text set to '' so nothing waits on it.
 */
export function measureUtterance(utterance) {
  if (utterance.energy) return tooQuiet(utterance.energy) ? null : utterance.energy;
  if (utterance.durationMs < MIN_UTTERANCE_MS) {
    utterance.text = '';
    return null;
  }
  const pcm = decodeToMono16k(utterance.packets);
  const energy = measureEnergy(pcm);
  utterance.energy = energy;
  if (tooQuiet(energy)) {
    clipLog.quiet(energy);
    utterance.text = '';
    return null;
  }
  // Kept until the request is sent, so the audio is not decoded twice.
  utterance.pcm = pcm;
  return energy;
}

async function runTranscription(utterance, stt) {
  const prompt = namePrompt();
  const energy = measureUtterance(utterance);
  if (!energy) return { spoken: false, failed: false, skipped: utterance.durationMs >= MIN_UTTERANCE_MS };
  const pcm = utterance.pcm ?? decodeToMono16k(utterance.packets);
  utterance.pcm = null;
  try {
    const text = await stt.transcribe(pcmToWav(pcm), {
      prompt,
    });
    // The prompt echo has to go before anything else reads the text: it
    // contains the bot's names, so it reads as someone calling the bot.
    let junk =
      echoesPrompt(text, prompt) ||
      (namesNoise(stt.model) && namedByNoise(text, prompt, energy)) ||
      looksHallucinated(text, utterance.durationMs);
    // A lone name from a GPT-4o model: real, or noise it dressed up? Ask the
    // other model before waking the bot on it.
    if (!junk && namesNoise(stt.model) && onlyTheNames(text, prompt)) {
      const second = (utterance.secondOpinion ?? secondOpinionFor)(stt);
      if (second) {
        try {
          const heard = await second.transcribe(pcmToWav(pcm), {
            prompt,
            // A confirmation must never cost more than the utterance it
            // confirms, and never inherit the primary's own retry — see
            // SECOND_OPINION_MS. Tallied under its own stage so a slow
            // whisper-1 never reads as a primary stt failure.
            deadlineMs: utterance.secondOpinionDeadlineMs ?? SECOND_OPINION_MS,
            retries: 0,
            stage: 'stt-confirm',
          });
          if (!hearsAName(heard, config.get('agentNames'))) {
            junk = true;
            console.log(`[stt] lone "${text.trim()}" not confirmed by whisper-1 (it heard "${String(heard).trim().slice(0, 60)}") → treated as noise`);
          }
        } catch (err) {
          // Unconfirmed either way: the first opinion stands rather than a
          // network hiccup costing a real call.
          if (err instanceof DeadlineError) {
            console.warn(`[stt] second opinion gave no answer in ${(err.ms / 1000).toFixed(1)}s — trusting "${text.trim()}"`);
          } else {
            console.warn(`[stt] second opinion failed: ${err.message}`);
          }
        }
      }
    }
    if (junk && text.trim()) clipLog.discarded(energy, text);
    else if (text.trim()) clipLog.kept(energy);
    utterance.text = junk ? '' : text;
    return { spoken: Boolean(utterance.text), failed: false };
  } catch (err) {
    if (err.fatal) throw err; // leave text null; the audio is still usable later
    // Marked consumed rather than left null, so one genuinely bad chunk isn't
    // retried on every subsequent question.
    utterance.text = '';
    console.warn(`[stt] utterance ${utterance.id} failed: ${err.message}`);
    return { spoken: false, failed: true };
  }
}

/** Run tasks with a bounded number in flight. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * Transcribe whatever in the buffer hasn't been transcribed yet, in parallel,
 * and cache the text back onto each utterance.
 *
 * The caching is what makes follow-up questions nearly free: ask something 30
 * seconds later and only those 30 seconds are new. It also caps the damage of
 * a false wake trigger.
 */
export async function transcribeBuffer(buffer, { provider = null } = {}) {
  const stt = provider ?? createProvider();
  const pending = buffer
    .untranscribed()
    .filter((u) => u.durationMs >= MIN_UTTERANCE_MS);

  const started = Date.now();
  let failed = 0;
  let fatal = null;

  await pool(pending, CONCURRENCY, async (utterance) => {
    // Once one request has failed fatally, every other one will too. Stop
    // rather than firing the rest of the buffer at a wall.
    if (fatal) return;

    try {
      const result = await transcribeUtterance(utterance, stt);
      if (result.failed) failed += 1;
    } catch (err) {
      // Only fatal errors reach here; transcribeUtterance handles the rest and
      // reports them in its result. Text is left null so the audio is still
      // there once the cause is fixed.
      fatal = err;
      console.warn(`[stt] aborting: ${err.message}`);
    }
  });

  if (fatal) throw fatal;

  if (pending.length > 0) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `[stt] ${pending.length} utterance(s) in ${seconds}s ` +
        `at concurrency ${CONCURRENCY}${failed ? ` (${failed} failed)` : ''}`,
    );
  }

  return {
    transcribed: pending.length,
    failed,
    elapsedMs: Date.now() - started,
    provider: stt.label,
  };
}

/** Speaker-labelled, chronological — the shape the model will eventually read. */
export function formatTranscript(utterances) {
  return utterances
    .filter((u) => u.text)
    .map((u) => {
      const time = new Date(u.startedAt).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `[${time}] ${u.displayName}: ${u.text}`;
    })
    .join('\n');
}

export { SttError, MIN_UTTERANCE_MS, looksHallucinated, OpenAiWhisper };
