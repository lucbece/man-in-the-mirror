/**
 * Reminders: the first thing that makes the bot speak without being spoken to.
 *
 * The agent has no clock — a turn lives two minutes at most, so "I'll tell
 * you in ten minutes" is a promise the model cannot keep. What it *can* do is
 * ask the bot to keep it: a tool call registers a plain setTimeout here, and
 * when it fires, the bot synthesises the message and says it in the channel.
 * The model composes the sentence now; the machine owns the clock.
 *
 * Persisted, which this deliberately was not at first. The old reasoning was
 * that a reminder is a promise made in a conversation, so if the bot restarted
 * the conversation was gone anyway. That holds for "remind me in two minutes"
 * and not at all for "remind me at six" — those are promises about the clock,
 * not about the conversation, and the bot said "listo, te aviso" before
 * quietly dropping them.
 *
 * What is *not* fixed by this: a reminder that came due while the process was
 * down is discarded rather than said late. Saying it hours afterwards, to
 * whoever happens to be in the channel now, is worse than not saying it — and
 * the bot may not be in a channel at all when it boots. That case is logged
 * rather than papered over.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../paths.js';

/**
 * A refusal the bot can say out loud.
 *
 * Every message thrown below is written to be spoken — "that is too soon for a
 * reminder, just say it now" — so it needs a type the tool wrapper recognises.
 * Thrown as a plain Error it escaped into the runtime instead, and the sentence
 * was never said.
 */
export class ReminderError extends Error {}

/** Below this, just answering takes as long as the wait. */
const MIN_DELAY_MS = 5_000;

/** A day. Past that it's a calendar entry, and this is not a calendar. */
const MAX_DELAY_MS = 24 * 60 * 60_000;

/** Per guild. Nobody legitimately has more; a confused agent might try. */
const MAX_PER_GUILD = 25;

export class Reminders extends EventEmitter {
  constructor({ file = path.join(DATA_DIR, 'reminders.json') } = {}) {
    super();
    this.file = file;
    this.byGuild = new Map(); // guildId → Map<id, {id, message, dueAt, timer}>
    this.nextId = 1;
  }

  /**
   * Everything pending, as plain data.
   *
   * The timer is deliberately absent: what survives a restart is the promise
   * and when it comes due, and the timer is rebuilt from that.
   */
  #pending() {
    const out = [];
    for (const [guildId, guild] of this.byGuild) {
      for (const { id, message, dueAt } of guild.values()) out.push({ guildId, id, message, dueAt });
    }
    return out;
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.#pending(), null, 2));
    } catch (err) {
      // Losing the file is not worth losing the reminder that is already
      // armed in memory, so this reports and carries on.
      console.warn(`[reminders] could not save: ${err.message}`);
    }
  }

  /**
   * Re-arm what was pending when the process last stopped.
   *
   * Returns `{ restored, missed }`. Anything already due is counted as missed
   * and dropped — see the note at the top of the file for why it is not said
   * late.
   */
  restore(now = Date.now()) {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { restored: 0, missed: 0 }; // no file, or nothing readable in it
    }
    if (!Array.isArray(saved)) return { restored: 0, missed: 0 };

    let restored = 0;
    let missed = 0;
    for (const entry of saved) {
      const { guildId, id, message, dueAt } = entry ?? {};
      if (!guildId || !message || !Number.isFinite(dueAt)) continue;
      if (dueAt <= now) {
        missed += 1;
        console.warn(
          `[reminders] missed while the bot was down, not saying it late: "${message}"`,
        );
        continue;
      }
      this.nextId = Math.max(this.nextId, (Number(id) || 0) + 1);
      this.#arm({ guildId, id: Number(id) || this.nextId++, message, dueAt, now });
      restored += 1;
    }

    if (restored || missed) {
      console.log(`[reminders] ${restored} restored, ${missed} missed while down`);
    }
    this.#save();
    return { restored, missed };
  }

  /** Put one in the map with a live timer. Shared by `set` and `restore`. */
  #arm({ guildId, id, message, dueAt, now = Date.now() }) {
    const guild = this.#guild(guildId);
    const entry = { id, message, dueAt };
    entry.timer = setTimeout(() => {
      guild.delete(id);
      this.#save();
      this.emit('fire', { guildId, id, message });
    }, Math.max(0, dueAt - now));
    // Don't let a pending timer hold the process open on shutdown.
    entry.timer.unref?.();
    guild.set(id, entry);
    return entry;
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
    if (!text) throw new ReminderError('The reminder needs a message to say.');
    if (!Number.isFinite(delayMs) || delayMs < MIN_DELAY_MS) {
      throw new ReminderError('That is too soon for a reminder — just say it now.');
    }
    if (delayMs > MAX_DELAY_MS) {
      throw new ReminderError('Reminders only go up to twenty-four hours.');
    }
    const guild = this.#guild(guildId);
    if (guild.size >= MAX_PER_GUILD) {
      throw new ReminderError('Too many pending reminders in this channel already.');
    }

    const id = this.nextId++;
    const entry = this.#arm({ guildId, id, message: text, dueAt: Date.now() + delayMs });
    this.#save();
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
    this.#save();
    return true;
  }

  /** Everything pending for a guild — for tests and hard resets. */
  clearGuild(guildId) {
    const guild = this.#guild(guildId);
    for (const entry of guild.values()) clearTimeout(entry.timer);
    const count = guild.size;
    guild.clear();
    this.#save();
    return count;
  }
}

export const reminders = new Reminders();
export { MIN_DELAY_MS, MAX_DELAY_MS, MAX_PER_GUILD };
