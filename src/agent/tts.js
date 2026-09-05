/**
 * Text to speech.
 *
 * Asks for Ogg Opus rather than MP3, which matters more than it looks: Discord
 * speaks Opus natively, so this plays through untouched. MP3 would have to be
 * decoded by ffmpeg and re-encoded by the pure-JS Opus encoder on every reply —
 * slower, and it shares one WASM heap with the decoder used for transcription,
 * which is a collision waiting to happen.
 */
import { Readable } from 'node:stream';
import { withDeadline, TTS_FIRST_BYTE_MS } from './deadline.js';
import { StreamType, createAudioResource } from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';

import { config } from '../config.js';
import {
  DEFAULT_VOICE,
  VOICES as LOCAL_VOICES,
  ensurePiper,
  ensureVoice,
  speak,
} from './piper.js';

class TtsError extends Error {}

class OpenAiTts {
  constructor({ apiKey, voice }) {
    if (!apiKey) throw new TtsError('No OpenAI API key configured.');
    this.apiKey = apiKey;
    this.voice = voice || 'onyx';
    // tts-1 over the higher-quality variants: this is conversational filler in
    // a noisy voice call, and latency matters far more than fidelity here.
    this.model = 'tts-1';
  }

  get label() {
    return `OpenAI ${this.model} (${this.voice})`;
  }

  async request(text) {
    // First byte within the deadline; the rest of the stream may take its time.
    const res = await withDeadline('tts', TTS_FIRST_BYTE_MS, (signal, arrived) =>
      fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        voice: this.voice,
        input: text,
        response_format: 'opus',
        stream_format: 'audio',
      }),
      signal,
    }).then((r) => {
      arrived();
      return r;
    }),
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TtsError(`OpenAI returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res;
  }

  /** Whole buffer. Used for the filler clips, which get cached to disk. */
  async synthesize(text) {
    const res = await this.request(text);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * A stream that can start playing before synthesis has finished.
   *
   * Measured on a two-sentence reply: the complete file lands at ~4.1s, but
   * the first bytes arrive at ~3.0s. Playing as it arrives is a second of
   * silence removed for free — the audio is already Ogg Opus, so Discord takes
   * it straight through without waiting for the end of the file.
   */
  async synthesizeStream(text) {
    const res = await this.request(text);
    return Readable.fromWeb(res.body);
  }
}

/**
 * Speech synthesised on this machine.
 *
 * Slower to set up — a 5MB binary and a ~60MB voice, downloaded once into
 * `runtime/` — and then consistently faster and free per use. The trade is the
 * voice itself: the quick models sound more synthetic than the cloud ones, and
 * the only Argentine voice available runs at cloud speed anyway.
 */
class LocalTts {
  constructor({ voice }) {
    this.voice = LOCAL_VOICES[voice] ? voice : DEFAULT_VOICE;
    this.ready = null;
  }

  get label() {
    return `Piper ${this.voice} (local)`;
  }

  /** Fetch binary and model on first use, once per process. */
  async prepare() {
    this.ready ??= (async () => {
      const started = Date.now();
      console.log(`[piper] preparing ${this.voice}…`);
      const binary = await ensurePiper();
      const model = await ensureVoice(this.voice);
      console.log(
        `[piper] ready in ${((Date.now() - started) / 1000).toFixed(1)}s — ${this.voice}`,
      );
      return { binary, model };
    })();
    return this.ready;
  }

  async synthesizeStream(text) {
    const { binary, model } = await this.prepare();
    return speak(text, {
      binary,
      model,
      ffmpeg: ffmpegPath,
      sampleRate: LOCAL_VOICES[this.voice].sampleRate,
    });
  }

  /** Whole buffer, for the filler clips that get cached to disk. */
  async synthesize(text) {
    const stream = await this.synthesizeStream(text);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
}

/**
 * Build the synthesiser to speak with — the configured one by default, or a
 * specific provider and voice when a caller needs to bypass the config, as
 * the voice preview route does: it is always asked about one exact voice,
 * whatever is currently configured for the running bot.
 */
export function createTts({ provider, voice } = {}) {
  if ((provider ?? config.get('ttsProvider')) === 'local') {
    return new LocalTts({ voice: voice ?? config.get('ttsLocalVoice') });
  }
  return new OpenAiTts({
    apiKey: config.get('openaiApiKey'),
    voice: voice ?? config.get('ttsVoice'),
  });
}

/**
 * Wrap synthesized audio so a VoiceSession's player can speak it.
 *
 * Declaring the type lets @discordjs/voice skip probing and, more importantly,
 * skip transcoding — Ogg Opus goes to Discord as-is.
 *
 * `inlineVolume` is deliberately off: it forces a decode/re-encode round trip
 * that undoes the whole point. Volume is applied by asking for it at the source
 * instead.
 */
export function toAudioResource(audio) {
  // A Buffer needs wrapping; a stream is already one.
  const stream = Buffer.isBuffer(audio) ? Readable.from(audio) : audio;
  return createAudioResource(stream, { inputType: StreamType.OggOpus });
}

export { TtsError };
