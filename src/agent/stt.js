/**
 * Speech to text.
 *
 * One interface, swappable implementations. Cloud today; local whisper.cpp is
 * a second implementation of this same shape, not a redesign — which matters,
 * because on a machine with a real GPU local is strictly better (same model,
 * no per-minute cost, audio never leaves the box).
 */
import { config } from '../config.js';
import { packetsToWav } from './audio.js';
import { MODELS, ensureModel, ensureWhisper, transcribeWav } from './whisper.js';

/** Below this an "utterance" is a cough or a mic bump. Not worth a request. */
const MIN_UTTERANCE_MS = 300;

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

function looksHallucinated(text, durationMs) {
  if (durationMs > HALLUCINATION_MAX_MS) return false;
  const bare = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return HALLUCINATIONS.has(bare);
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
  constructor({ apiKey }) {
    if (!apiKey) throw new SttError('No OpenAI API key configured.');
    this.apiKey = apiKey;
    this.model = 'whisper-1';
  }

  get label() {
    return `OpenAI ${this.model}`;
  }

  async transcribe(wav, { language, prompt } = {}) {
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

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

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

    const json = await res.json();
    return (json.text ?? '').trim();
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
  return `Conversación en un canal de voz con un asistente llamado ${names.join(' o ')}.`;
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
  return new OpenAiWhisper({ apiKey: config.get('openaiApiKey') });
}

/**
 * Transcribe one utterance in place. Returns true if it now has text.
 *
 * Shared by the on-demand path and the eager background queue so both handle
 * failures — and the fatal-vs-transient distinction — identically.
 */
export async function transcribeUtterance(utterance, stt) {
  if (utterance.text !== null) return true;
  if (utterance.durationMs < MIN_UTTERANCE_MS) {
    utterance.text = '';
    return false;
  }

  try {
    const text = await stt.transcribe(packetsToWav(utterance.packets), {
      prompt: namePrompt(),
    });
    utterance.text = looksHallucinated(text, utterance.durationMs) ? '' : text;
    return Boolean(utterance.text);
  } catch (err) {
    if (err.fatal) throw err; // leave text null; the audio is still usable later
    utterance.text = '';
    console.warn(`[stt] utterance ${utterance.id} failed: ${err.message}`);
    return false;
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
      const wav = packetsToWav(utterance.packets);
      const text = await stt.transcribe(wav, { prompt: namePrompt() });
      utterance.text = looksHallucinated(text, utterance.durationMs) ? '' : text;
    } catch (err) {
      if (err.fatal) {
        // Leave text null so the audio is still there once the cause is fixed.
        fatal = err;
        console.warn(`[stt] aborting: ${err.message}`);
        return;
      }
      // One genuinely bad chunk shouldn't lose the whole conversation. Mark it
      // consumed so it isn't retried on every subsequent question.
      utterance.text = '';
      failed += 1;
      console.warn(`[stt] utterance ${utterance.id} failed: ${err.message}`);
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

export { SttError, MIN_UTTERANCE_MS, looksHallucinated };
