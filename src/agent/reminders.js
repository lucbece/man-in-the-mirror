/**
 * Reminders: the first thing that makes the bot speak without being spoken to.
 *
 * The agent has no clock — a turn lives two minutes at most, so "I'll tell
 * you in ten minutes" is a promise the model cannot keep. What it *can* do is
 * ask the bot to keep it: a tool call registers a plain setTimeout here, and
 * when it fires, the bot synthesises the message and says it in the channel.
 * The model composes the sentence now; the machine owns the clock.
 *
 * Deliberately not persisted: these live in memory and die with the process.
 * A reminder is a promise made in a conversation; if the bot was restarted,
 * the conversation it was promised in is gone too. Worth revisiting only if
 * people start setting hours-long reminders.
 */
import { EventEmitter } from 'node:events';

/** Below this, just answering takes as long as the wait. */
const MIN_DELAY_MS = 5_000;

/** A day. Past that it's a calendar entry, and this is not a calendar. */
const MAX_DELAY_MS = 24 * 60 * 60_000;

/** Per guild. Nobody legitimately has more; a confused agent might try. */
const MAX_PER_GUILD = 25;

class Reminders extends EventEmitter {
  constructor() {
    super();
    this.byGuild = new Map(); // guildId → Map<id, {id, message, dueAt, timer}>
    this.nextId = 1;
  }

  #guild(guildId) {
    let map = this.byGuild.get(guildId);
    if (!map) {
      map = new Map();
      this.byGuild.set(guildId, map);
    }
    return map;
  }

  /** Register one. Throws with a speakable message when the ask is unreasonable. */
  set({ guildId, delayMs, message }) {
    const text = String(message ?? '').trim();
    if (!text) throw new Error('The reminder needs a message to say.');
    if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS) {
      throw new Error('That is too soon for a reminder — just say it now.');
    }
    if (delayMs > MAX_DELAY_MS) {
      throw new Error('Reminders only go up to twenty-four hours.');
    }
    const guild = this.#guild(guildId);
    if (guild.size >= MAX_PER_GUILD) {
      throw new Error('Too many pending reminders in this channel already.');
    }

    const id = this.nextId++;
    const entry = { id, message: text, dueAt: Date.now() + delayMs };
    entry.timer = setTimeout(() => {
      guild.delete(id);
      this.emit('fire', { guildId, id, message: text });
    }, delayMs);
    // Don't let a pending timer hold the process open on shutdown.
    entry.timer.unref?.();

    guild.set(id, entry);
    return { id, dueAt: entry.dueAt };
  }

  list(guildId, now = Date.now()) {
    return [...this.#guild(guildId).values()]
      .sort((a, b) => a.dueAt - b.dueAt)
      .map(({ id, message, dueAt }) => ({
        id,
        message,
        dueAt,
        remainingMs: Math.max(0, dueAt - now),
      }));
  }

  cancel(guildId, id) {
    const guild = this.#guild(guildId);
    const entry = guild.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    guild.delete(id);
    return true;
  }

  /** Everything pending for a guild — for tests and hard resets. */
  clearGuild(guildId) {
    const guild = this.#guild(guildId);
    for (const entry of guild.values()) clearTimeout(entry.timer);
    const count = guild.size;
    guild.clear();
    return count;
  }
}

export const reminders = new Reminders();
export { MIN_DELAY_MS, MAX_DELAY_MS, MAX_PER_GUILD };
