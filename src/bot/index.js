import { EventEmitter } from 'node:events';
import { Client, Events, GatewayIntentBits } from 'discord.js';

import { config } from '../config.js';
import { sessionManager } from '../voice/manager.js';
import { commandData, handleInteraction } from './commands.js';

/**
 * Owns the Discord client lifecycle so the web UI can start, stop and restart
 * the bot when the token changes — without restarting the whole process.
 */
class BotRunner extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.state = 'stopped'; // stopped | starting | ready | error
    this.error = null;
    this.user = null;
    /**
     * Lifecycle operations run one at a time, chained onto this.
     *
     * Seen in a real log: two "logged in as" lines from one process, meaning
     * two gateway connections on one token. Every handler is then registered
     * twice, so a single slash command is handled twice — and the guard that
     * was supposed to prevent it (`if (this.isRunning) return`) can't, because
     * stop() and start() interleave across their awaits. Restarts come from
     * the web panel and aren't awaited, so two saves in quick succession are
     * all it takes.
     */
    this.chain = Promise.resolve();
  }

  /** Run `fn` after whatever lifecycle work is already queued. */
  #serial(fn) {
    const next = this.chain.then(fn, fn);
    // Keep the chain alive even if this operation rejects.
    this.chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  get isRunning() {
    return this.state === 'starting' || this.state === 'ready';
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.emit('state', this.status());
  }

  start(token = config.get('token')) {
    return this.#serial(() => this.#start(token));
  }

  stop() {
    return this.#serial(() => this.#stop());
  }

  restart(token = config.get('token')) {
    return this.#serial(async () => {
      await this.#stop();
      return this.#start(token);
    });
  }

  async #start(token) {
    if (this.isRunning) return this.status();
    if (!token) {
      this.setState('stopped', 'No bot token configured.');
      return this.status();
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });
    this.client = client;
    this.setState('starting');

    client.on(Events.InteractionCreate, (interaction) => handleInteraction(interaction));
    client.on(Events.Error, (err) => console.error('[bot] client error:', err.message));

    client.once(Events.ClientReady, async (ready) => {
      // Something replaced us while we were connecting. Two live gateway
      // connections on one token means every event fires twice, so this one
      // goes rather than lingering as a second brain.
      if (this.client !== client) {
        console.warn('[bot] a stale connection became ready — dropping it');
        await client.destroy().catch(() => {});
        return;
      }
      this.user = { id: ready.user.id, tag: ready.user.tag };
      console.log(`[bot] logged in as ${ready.user.tag}`);
      try {
        await registerCommands(ready);
      } catch (err) {
        console.error(`[bot] command registration failed: ${err.message}`);
      }
      this.setState('ready');
    });

    // If the bot gets dragged out of a channel, drop the session with it.
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (oldState.member?.id !== client.user?.id) return;
      if (oldState.channelId && !newState.channelId) {
        sessionManager.leave(oldState.guild.id);
      }
    });

    try {
      await client.login(token);
    } catch (err) {
      console.error(`[bot] login failed: ${err.message}`);
      this.client = null;
      this.user = null;
      await client.destroy().catch(() => {});
      this.setState('error', err.message);
    }

    return this.status();
  }

  async #stop() {
    sessionManager.leaveAll();
    if (this.client) {
      await this.client.destroy().catch(() => {});
      this.client = null;
    }
    this.user = null;
    this.setState('stopped');
    return this.status();
  }

  /** Voice channels the bot can see, for the UI's channel picker. */
  guildOverview() {
    if (this.state !== 'ready' || !this.client) return [];
    return this.client.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
      channels: guild.channels.cache
        .filter((c) => c.isVoiceBased())
        .map((c) => ({ id: c.id, name: c.name, members: c.members?.size ?? 0 }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  status() {
    return {
      state: this.state,
      error: this.error,
      user: this.user,
      guildCount: this.client?.guilds?.cache?.size ?? 0,
    };
  }
}

async function registerCommands(client) {
  const guildId = config.get('guildId');
  if (guildId) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(commandData);
    console.log(`[bot] registered guild commands on ${guild.name}`);
    return;
  }
  await client.application.commands.set(commandData);
  console.log('[bot] registered global commands (can take up to an hour to appear)');
}

export const bot = new BotRunner();
