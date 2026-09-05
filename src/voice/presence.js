/**
 * Where the bot was, so a restart puts it back.
 *
 * The voice session lives in the process, and a deploy restarts the process:
 * the bot was simply gone from the channel until somebody ran /mj join again,
 * once per merge. The session knows its guild and channel; writing them down
 * when it joins and reading them back at boot makes a deploy a few seconds of
 * absence rather than an absence.
 *
 * Only a channel left *involuntarily* is remembered: a shutdown, a crash, a
 * lost connection. Being told to leave, by voice or by command, forgets it,
 * because coming back after that is exactly the behaviour that gets a bot
 * removed from a server. And it only comes back to a channel that still has
 * people in it, within a short while of leaving.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../paths.js';

/** Longer than this away, and whoever was in the call has moved on. */
export const REJOIN_WITHIN_MS = 15 * 60_000;

export class Presence {
  constructor({ file = path.join(DATA_DIR, 'voice.json'), now = Date.now } = {}) {
    this.file = file;
    this.now = now;
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  #write(state) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn(`[voice] could not remember the channel: ${err.message}`);
    }
  }

  /** The bot is in this channel now. */
  remember(guildId, channelId) {
    const state = this.#read();
    state[guildId] = { channelId, at: this.now() };
    this.#write(state);
  }

  /** The bot was asked to leave: nothing to come back to. */
  forget(guildId) {
    const state = this.#read();
    if (!(guildId in state)) return;
    delete state[guildId];
    this.#write(state);
  }

  /** Channels left recently enough to be worth returning to: `[{ guildId, channelId }]`. */
  recent(withinMs = REJOIN_WITHIN_MS) {
    const state = this.#read();
    const cutoff = this.now() - withinMs;
    return Object.entries(state)
      .filter(([, v]) => v && typeof v.channelId === 'string' && typeof v.at === 'number' && v.at >= cutoff)
      .map(([guildId, v]) => ({ guildId, channelId: v.channelId }));
  }
}

/**
 * Go back to the channels the bot was in when it went down, if anyone is
 * still there. `fetchChannel(id)` resolves to a voice channel or null;
 * `join(channel)` is the session manager's. Returns what it rejoined.
 */
export async function rejoinRecent(presence, { fetchChannel, join, log = console.log }) {
  const back = [];
  for (const { guildId, channelId } of presence.recent()) {
    let channel = null;
    try {
      channel = await fetchChannel(channelId);
    } catch (err) {
      log(`[voice] could not look up the channel it was in (${guildId}): ${err.message}`);
    }
    const people = channel?.members ? [...channel.members.values()].filter((m) => !m.user?.bot).length : 0;
    if (!channel || !people) {
      // Nobody to come back to. Forgotten so the next boot does not try again.
      presence.forget(guildId);
      log(`[voice] not rejoining ${channel?.name ? `#${channel.name}` : guildId}: ${channel ? 'nobody is there' : 'channel is gone'}`);
      continue;
    }
    try {
      await join(channel);
      back.push({ guildId, channelId, name: channel.name });
      log(`[voice] back in #${channel.name} after the restart (${people} there)`);
    } catch (err) {
      log(`[voice] could not rejoin #${channel.name}: ${err.message}`);
    }
  }
  return back;
}

export const presence = new Presence();
