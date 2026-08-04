import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

import { config } from '../config.js';
import { SpeechQueue } from './speech-queue.js';
import { VoiceReceiver } from './receiver.js';
import { EagerTranscriber } from '../agent/eager.js';
import { detectAddress, normalise, splitNames } from '../agent/wake.js';

const READY_TIMEOUT_MS = 20_000;

/** Ignore a repeat wake this soon after the last one. */
const WAKE_COOLDOWN_MS = 4_000;

/**
 * How long to wait for more of the question after the speaker pauses.
 *
 * An utterance ends after half a second of silence, which is shorter than the
 * pause people leave mid-sentence — so without this, "espejo, qué opinás
 * de… los servidores?" would be cut off at the ellipsis. Every further
 * utterance from the same person restarts this clock.
 *
 * Every millisecond here is dead air before the reply, so it's as short as it
 * can be while still surviving a breath.
 */
const WAKE_GRACE_MS = 900;

/**
 * Longer wait when the phrase arrived with nothing after it. "Hey mirror…"
 * followed by a beat and then the actual question is how people naturally
 * address something, and it deserves more patience than a trailing pause.
 */
const WAKE_OPEN_MS = 6_000;

/**
 * Exported as a mutable object so tests can shrink the waits. Everything below
 * reads through it rather than closing over the constants.
 */
export const WAKE_TIMING = {
  cooldownMs: WAKE_COOLDOWN_MS,
  graceMs: WAKE_GRACE_MS,
  openMs: WAKE_OPEN_MS,
};

/**
 * One guild's voice presence: the connection, the player it speaks through, and
 * the receiver it listens with.
 */
export class VoiceSession extends EventEmitter {
  constructor(channel) {
    super();
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.guildName = channel.guild.name;
    this.client = channel.client;

    this.destroyed = false;

    // Kept for the agent's own voice — TTS output plays through here.
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on('error', (err) => {
      console.error(`[voice:${this.guildId}] player error: ${err.message}`);
      this.emit('error', err);
    });

    this.player.on(AudioPlayerStatus.Idle, () => this.emit('update'));

    // Self-deafening is what stops Discord sending us any audio at all. While
    // listening is off we stay deafened — and Discord shows the deafened icon
    // next to the bot, so "can this thing hear me?" is answered in the member
    // list rather than by trusting us.
    this.agentEnabled = config.get('agentEnabled');

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: !this.agentEnabled,
      selfMute: false,
    });

    this.connection.subscribe(this.player);
    this.attachConnectionHandlers();

    this.receiver = new VoiceReceiver(this.connection, {
      guildId: this.guildId,
      client: this.client,
      windowSeconds: config.get('bufferSeconds'),
    });

    this.eager = null;
    this.lastWakeAt = 0;
    /** Set while we're still hearing out someone's question. */
    this.pendingWake = null;
    this.receiver.on('utterance', (utterance) => this.onUtterance(utterance));
  }

  // --- eager transcription and waking ---------------------------------------

  onUtterance(utterance) {
    if (!config.get('eagerTranscription')) return;

    this.eager ??= this.createEager();
    this.eager.push(utterance);
  }

  createEager() {
    const eager = new EagerTranscriber({ label: `:${this.guildId}` });
    eager.on('transcribed', (utterance) => this.checkForWake(utterance));
    return eager;
  }

  /**
   * A freshly transcribed utterance is the only place a wake phrase can appear,
   * so this is where the bot decides it's being spoken to.
   */
  checkForWake(utterance) {
    if (!config.get('wakeEnabled') || this.destroyed) return;

    // Already listening to someone's question — this is more of it, not a new one.
    if (this.pendingWake) return this.extendWake(utterance);

    const { matched, name, closest } = detectAddress(utterance.text, config.get('agentNames'));
    if (!matched) {
      // A near miss is almost always transcription mangling the name, which is
      // invisible otherwise — the bot just sits there saying nothing.
      if (closest && closest.score >= 0.55) {
        console.log(
          `[wake] near miss: heard "${closest.heard}" vs "${closest.name}" ` +
            `(${closest.score.toFixed(2)}) in: "${utterance.text}"`,
        );
      }
      return;
    }
    console.log(`[wake] addressed as "${name}" in: "${utterance.text}"`);

    // Someone saying the phrase twice in quick succession means one answer,
    // not two talking over each other.
    const now = Date.now();
    if (now - this.lastWakeAt < WAKE_TIMING.cooldownMs) return;
    this.lastWakeAt = now;

    // The whole sentence is the request. The name can sit anywhere in it —
    // "mirror, what do you think" and "what do you think, mirror" are the same
    // ask — so slicing at the name would throw away half of them.
    this.pendingWake = {
      userId: utterance.userId,
      askedBy: utterance.displayName,
      parts: [utterance.text.trim()],
      heard: utterance.text,
      timer: null,
    };
    // Just its name and nothing else means they're winding up to ask.
    const onlyTheName = normalise(utterance.text).split(' ').length <= 2;
    this.armWake(onlyTheName ? WAKE_TIMING.openMs : WAKE_TIMING.graceMs);
  }

  /**
   * The speaker kept talking. Append it and restart the clock, so a question
   * with a pause in the middle of it doesn't get cut in half.
   */
  extendWake(utterance) {
    const pending = this.pendingWake;
    if (utterance.userId !== pending.userId) return; // someone else talking over
    if (!utterance.text.trim()) return;

    pending.parts.push(utterance.text.trim());
    pending.heard += ` ${utterance.text.trim()}`;
    this.armWake(WAKE_TIMING.graceMs);
  }

  /** (Re)start the "have they finished talking?" timer. */
  armWake(delayMs) {
    const pending = this.pendingWake;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.fireWake(), delayMs);
    pending.timer.unref?.();
  }

  fireWake() {
    const pending = this.pendingWake;
    this.pendingWake = null;
    if (!pending || this.destroyed) return;

    const question = pending.parts.join(' ').trim();

    // Someone said its name and nothing else. Handing the model the single
    // word "mirror" as a question invites it to invent one, so say plainly
    // that there wasn't one.
    const bareSummon = normalise(question)
      .split(' ')
      .filter((word) => !splitNames(config.get('agentNames')).some((n) => normalise(n) === word))
      .join('')
      .length === 0;

    this.emit('wake', {
      question:
        bareSummon || !question
          ? 'They said your name but nothing else. Ask what they want, in a few words.'
          : question,
      askedBy: pending.askedBy,
      heard: pending.heard,
    });
  }

  cancelWake() {
    if (this.pendingWake?.timer) clearTimeout(this.pendingWake.timer);
    this.pendingWake = null;
  }

  attachConnectionHandlers() {
    this.connection.on('error', (err) => {
      console.error(`[voice:${this.guildId}] connection error: ${err.message}`);
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Either a genuine drop or a channel move. Give it a moment to recover
      // on its own before tearing everything down.
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        console.warn(`[voice:${this.guildId}] disconnected, cleaning up`);
        this.destroy();
      }
    });

    this.connection.on(VoiceConnectionStatus.Destroyed, () => {
      this.destroyed = true;
      this.emit('destroyed');
    });
  }

  async waitUntilReady() {
    await entersState(this.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    // Only subscribe to speakers once the connection can actually carry audio.
    if (this.agentEnabled) this.receiver.start();
    return this;
  }

  // --- listening ------------------------------------------------------------

  /**
   * Turn listening on or off at runtime. The deafen flag is part of the join
   * config, so flipping it means re-announcing our voice state — that's what
   * updates the icon everyone else sees.
   */
  async setAgentEnabled(enabled) {
    if (this.destroyed || enabled === this.agentEnabled) return this.agentEnabled;
    this.agentEnabled = enabled;

    try {
      this.connection.rejoin({ selfDeaf: !enabled, selfMute: false });
    } catch (err) {
      console.warn(`[voice:${this.guildId}] could not update deafen state: ${err.message}`);
    }

    if (enabled) {
      await entersState(this.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      this.receiver.start();
    } else {
      this.receiver.stop({ clear: true });
      this.eager?.stop();
      this.eager = null;
      this.cancelWake();
    }

    this.emit('update');
    return this.agentEnabled;
  }

  // --- speaking -------------------------------------------------------------

  humansInChannel() {
    const channel = this.client.channels.cache.get(this.channelId);
    if (!channel) return 0;
    return channel.members.filter((m) => !m.user.bot).size;
  }

  /** Whether the agent is mid-sentence — used to avoid talking over itself. */
  get speaking() {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  /**
   * Begin one continuous spoken answer.
   *
   * Replaces whatever was being said — a second answer starting over the top
   * of the first is worse than a slightly delayed one.
   */
  startSpeech() {
    this.speech?.cancel();
    this.player.stop(true);
    this.speech = new SpeechQueue(this.player);
    return this.speech;
  }

  /** Cut off playback immediately. Backs a "stop talking" control. */
  shush() {
    // Cancel the queue first: stopping the player alone would just start the
    // next sentence, which is the opposite of being asked to stop.
    this.speech?.cancel();
    this.speech = null;
    this.player.stop(true);
    this.emit('update');
  }

  /** Apply a live volume change to whatever is currently playing. */
  applyVolume(volume) {
    const resource = this.player.state.resource;
    resource?.volume?.setVolume(volume);
  }

  destroy() {
    this.cancelWake();
    try {
      this.eager?.stop();
    } catch {
      /* never started */
    }
    try {
      this.receiver.stop({ clear: true });
    } catch {
      /* never started */
    }
    try {
      this.speech?.cancel();
      this.speech = null;
      this.player.stop(true);
    } catch {
      /* already stopped */
    }
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        this.connection.destroy();
      } catch {
        /* already destroyed */
      }
    }
    this.destroyed = true;
  }

  status() {
    return {
      guildId: this.guildId,
      guildName: this.guildName,
      channelId: this.channelId,
      channelName: this.channelName,
      listeners: this.humansInChannel(),
      speaking: this.speaking,
      agentEnabled: this.agentEnabled,
      listening: this.receiver.status(),
      eager: this.eager?.status() ?? null,
      agentNames: config.get('agentNames'),
      wakeEnabled: config.get('wakeEnabled'),
    };
  }
}
