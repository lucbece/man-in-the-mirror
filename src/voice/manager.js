import { EventEmitter } from 'node:events';

import { config } from '../config.js';
import { VoiceSession } from './session.js';
import { ask, AgentBusyError } from '../agent/index.js';

/** Tracks one VoiceSession per guild. */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();

    config.on('change', (values) => {
      for (const session of this.sessions.values()) {
        // Volume is worth applying mid-sentence.
        session.applyVolume(values.volume);
        session.receiver?.setWindow(values.bufferSeconds);
      }
    });
  }

  get(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  list() {
    return [...this.sessions.values()];
  }

  /** Join (or move to) a voice channel and return the ready session. */
  async join(channel) {
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

    // Someone said the wake phrase out loud. This is the whole point.
    session.on('wake', async ({ question, askedBy, heard }) => {
      console.log(`[wake] ${askedBy}: "${heard}"`);
      try {
        const result = await ask(session, { question, askedBy });
        console.log(`[wake] answered: "${result.spoken}"`);
      } catch (err) {
        // Don't speak errors into the channel — that's worse than silence.
        if (!(err instanceof AgentBusyError)) {
          console.warn(`[wake] could not answer: ${err.message}`);
        }
      }
    });

    try {
      await session.waitUntilReady();
    } catch (err) {
      session.destroy();
      this.sessions.delete(channel.guild.id);
      throw new Error(`Could not connect to ${channel.name}: ${err.message}`);
    }

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
