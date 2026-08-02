import { EventEmitter } from 'node:events';

import { config } from '../config.js';
import { VoiceSession } from './session.js';

/** Tracks one VoiceSession per guild. */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();

    // Volume is the one setting worth applying mid-clip.
    config.on('change', (values) => {
      for (const session of this.sessions.values()) session.applyVolume(values.volume);
    });
  }

  get(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  list() {
    return [...this.sessions.values()];
  }

  /** Join (or move to) a voice channel and return the ready session. */
  async join(channel, { autoStart = config.get('autoStart') } = {}) {
    const existing = this.sessions.get(channel.guild.id);
    if (existing && !existing.destroyed) {
      if (existing.channelId === channel.id) return existing;
      existing.destroy();
      this.sessions.delete(channel.guild.id);
    }

    const session = new VoiceSession(channel);
    this.sessions.set(channel.guild.id, session);

    session.on('destroyed', () => {
      if (this.sessions.get(channel.guild.id) === session) {
        this.sessions.delete(channel.guild.id);
      }
      this.emit('update');
    });
    session.on('update', () => this.emit('update'));

    try {
      await session.waitUntilReady();
    } catch (err) {
      session.destroy();
      this.sessions.delete(channel.guild.id);
      throw new Error(`Could not connect to ${channel.name}: ${err.message}`);
    }

    if (autoStart) session.start();
    this.emit('update');
    return session;
  }

  leave(guildId) {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.destroy();
    this.sessions.delete(guildId);
    this.emit('update');
    return true;
  }

  leaveAll() {
    for (const guildId of [...this.sessions.keys()]) this.leave(guildId);
  }

  status() {
    return this.list().map((s) => s.status());
  }
}

export const sessionManager = new SessionManager();
