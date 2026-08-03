/**
 * Listening side of a voice connection.
 *
 * Discord hands us one audio stream per speaker, which is a gift: speaker
 * labels come free, with no diarization to get wrong. Each stream ends after a
 * short silence, so utterances arrive pre-segmented — exactly the chunks we
 * want to transcribe in parallel later.
 *
 * Packets are stored as raw Opus. Nothing is decoded here, so idle listening
 * costs almost no CPU.
 */
import { EventEmitter } from 'node:events';
import { EndBehaviorType } from '@discordjs/voice';

import { AudioBuffer, Utterance } from '../agent/buffer.js';

/**
 * Silence that ends an utterance.
 *
 * Sits directly on the critical path: nothing is transcribed, and no wake can
 * fire, until this elapses. The pause-in-the-middle-of-a-sentence case is
 * handled downstream by the wake grace window, so this can be tighter than it
 * looks.
 */
const SILENCE_MS = 500;

/** Ignore anything longer than this — almost certainly a stuck stream. */
const MAX_UTTERANCE_MS = 60_000;

export class VoiceReceiver extends EventEmitter {
  constructor(connection, { guildId, client, windowSeconds = 180 }) {
    super();
    this.connection = connection;
    this.guildId = guildId;
    this.client = client;
    this.buffer = new AudioBuffer({ windowSeconds });
    this.active = new Map(); // userId -> Utterance
    this.listening = false;
    this.onSpeakingStart = (userId) => this.capture(userId);
  }

  start() {
    if (this.listening) return;
    this.listening = true;
    this.connection.receiver.speaking.on('start', this.onSpeakingStart);
  }

  stop({ clear = true } = {}) {
    if (!this.listening) return;
    this.listening = false;
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);

    for (const userId of this.active.keys()) {
      try {
        this.connection.receiver.subscriptions.get(userId)?.destroy();
      } catch {
        /* already gone */
      }
    }
    this.active.clear();
    if (clear) this.buffer.clear();
  }

  setWindow(seconds) {
    this.buffer.setWindow(seconds);
  }

  displayNameFor(userId) {
    const guild = this.client.guilds.cache.get(this.guildId);
    const member = guild?.members.cache.get(userId);
    return member?.displayName ?? member?.user?.username ?? `user-${userId.slice(-4)}`;
  }

  isBot(userId) {
    const guild = this.client.guilds.cache.get(this.guildId);
    return guild?.members.cache.get(userId)?.user?.bot ?? false;
  }

  capture(userId) {
    if (!this.listening) return;
    if (this.active.has(userId)) return; // already recording this speaker
    if (userId === this.client.user?.id) return; // never record ourselves
    if (this.isBot(userId)) return;

    const utterance = new Utterance({
      userId,
      displayName: this.displayNameFor(userId),
      startedAt: Date.now(),
    });
    this.active.set(userId, utterance);

    const stream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });

    const finish = () => {
      this.active.delete(userId);
      utterance.endedAt = Date.now();
      if (utterance.durationMs <= MAX_UTTERANCE_MS) {
        this.buffer.add(utterance);
        // Whoever is listening decides what to do with it — transcribe it
        // eagerly, watch it for a wake phrase, or nothing at all.
        this.emit('utterance', utterance);
      }
    };

    stream.on('data', (packet) => utterance.push(packet));
    stream.on('end', finish);
    stream.on('error', (err) => {
      console.warn(`[receiver:${this.guildId}] stream for ${userId}: ${err.message}`);
      finish();
    });
  }

  status() {
    return {
      listening: this.listening,
      speakingNow: this.active.size,
      ...this.buffer.stats(),
    };
  }
}

export { SILENCE_MS };
