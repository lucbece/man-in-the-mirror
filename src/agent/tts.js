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
import { StreamType, createAudioResource } from '@discordjs/voice';

import { config } from '../config.js';

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

  async synthesize(text) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
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
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TtsError(`OpenAI returned ${res.status}: ${detail.slice(0, 200)}`);
    }

    return Buffer.from(await res.arrayBuffer());
  }
}

export function createTts() {
  return new OpenAiTts({
    apiKey: config.get('openaiApiKey'),
    voice: config.get('ttsVoice'),
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
  return createAudioResource(Readable.from(audio), {
    inputType: StreamType.OggOpus,
  });
}

export { TtsError };
