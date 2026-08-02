import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

import { config } from '../config.js';
import { sounds } from '../sounds.js';

const READY_TIMEOUT_MS = 20_000;

/**
 * One guild's voice presence: the connection, the player, and the timer that
 * decides when Michael shows up next.
 */
export class VoiceSession extends EventEmitter {
  constructor(channel) {
    super();
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.guildName = channel.guild.name;
    this.client = channel.client;

    this.running = false;
    this.destroyed = false;
    this.timer = null;
    this.nextPlayAt = null;
    this.lastPlayed = null;
    this.lastPlayedAt = null;
    this.playCount = 0;

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on('error', (err) => {
      console.error(`[voice:${this.guildId}] player error: ${err.message}`);
      this.emit('error', err);
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      // A clip just finished (or failed). Queue the next one.
      if (this.running) this.scheduleNext();
      this.emit('update');
    });

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.subscribe(this.player);
    this.attachConnectionHandlers();
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
      this.cleanupTimer();
      this.destroyed = true;
      this.emit('destroyed');
    });
  }

  async waitUntilReady() {
    await entersState(this.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    return this;
  }

  // --- scheduling -----------------------------------------------------------

  start({ immediate } = {}) {
    if (this.destroyed) return;
    this.running = true;
    const playNow = immediate ?? config.get('playOnJoin');
    if (playNow) this.playRandom();
    else this.scheduleNext();
    this.emit('update');
  }

  stop() {
    this.running = false;
    this.cleanupTimer();
    this.player.stop(true);
    this.nextPlayAt = null;
    this.emit('update');
  }

  cleanupTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Random delay inside the configured window, in milliseconds. */
  pickDelayMs() {
    const min = config.get('minIntervalSeconds');
    const max = config.get('maxIntervalSeconds');
    const seconds = min + Math.random() * (max - min);
    return Math.round(seconds * 1000);
  }

  scheduleNext(delayMs = this.pickDelayMs()) {
    this.cleanupTimer();
    if (!this.running || this.destroyed) return;

    this.nextPlayAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.playRandom();
    }, delayMs);
    this.timer.unref?.();

    this.emit('update');
  }

  /** Seconds until the next scheduled clip, or null when idle. */
  secondsUntilNext() {
    if (!this.running || this.nextPlayAt === null) return null;
    return Math.max(0, Math.round((this.nextPlayAt - Date.now()) / 1000));
  }

  // --- playback -------------------------------------------------------------

  humansInChannel() {
    const channel = this.client.channels.cache.get(this.channelId);
    if (!channel) return 0;
    return channel.members.filter((m) => !m.user.bot).size;
  }

  /**
   * Play one clip. `file` defaults to a random pick from the library.
   * Returns the file played, or null if nothing was played.
   */
  playRandom(file = null) {
    if (this.destroyed) return null;

    if (config.get('pauseWhenAlone') && this.humansInChannel() === 0) {
      // Nobody to startle. Skip this turn but keep the rhythm going.
      if (this.running) this.scheduleNext();
      return null;
    }

    const target = file ?? sounds.next();
    if (!target) {
      this.emit('empty');
      if (this.running) this.scheduleNext();
      return null;
    }

    try {
      const resource = createAudioResource(target, { inlineVolume: true });
      resource.volume?.setVolume(config.get('volume'));
      this.player.play(resource);

      this.lastPlayed = path.basename(target);
      this.lastPlayedAt = Date.now();
      this.playCount += 1;
      this.nextPlayAt = null; // re-scheduled when the clip finishes
      this.emit('played', this.lastPlayed);
      this.emit('update');
      return target;
    } catch (err) {
      console.error(`[voice:${this.guildId}] failed to play ${target}: ${err.message}`);
      if (this.running) this.scheduleNext();
      return null;
    }
  }

  /** Apply a live volume change to whatever is currently playing. */
  applyVolume(volume) {
    const resource = this.player.state.resource;
    resource?.volume?.setVolume(volume);
  }

  destroy() {
    this.cleanupTimer();
    this.running = false;
    try {
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
      running: this.running,
      playing: this.player.state.status === AudioPlayerStatus.Playing,
      listeners: this.humansInChannel(),
      lastPlayed: this.lastPlayed,
      lastPlayedAt: this.lastPlayedAt,
      playCount: this.playCount,
      secondsUntilNext: this.secondsUntilNext(),
    };
  }
}
