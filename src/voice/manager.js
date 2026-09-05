import { EventEmitter } from 'node:events';

import { config } from '../config.js';
import { VoiceSession } from './session.js';
import { AudioPlayerStatus, entersState } from '@discordjs/voice';

import { ask, AgentBusyError } from '../agent/index.js';
import { endAgentSession, warmAgentSession } from '../agent/agent-brain.js';
import { forgetCascade } from '../agent/cascade.js';
import { providerFor } from '../agent/models.js';
import { reminders } from '../agent/reminders.js';
import { noteInMusicChannel } from '../agent/tools/music.js';
import { createTts, toAudioResource } from '../agent/tts.js';
import { clampForSpeech } from '../agent/brain.js';
import { warmFillers } from '../agent/filler.js';

/**
 * Tracks one VoiceSession per guild.
 *
 * `createSession` exists so this can be exercised without a Discord gateway:
 * a real session opens a UDP voice connection in its constructor, which makes
 * the registry — the part that has actually broken — untestable by accident
 * rather than by nature. Production passes nothing and gets a real one.
 */
export class SessionManager extends EventEmitter {
  constructor({
    createSession = (channel) => new VoiceSession(channel),
    warmAgent = warmAgentSession,
  } = {}) {
    super();
    this.sessions = new Map();
    this.createSession = createSession;
    // Injected for the same reason as createSession, and it matters more:
    // unstubbed, joining a channel starts a real Agent SDK subprocess holding
    // about a gigabyte. A test for a Map should not do that.
    this.warmAgent = warmAgent;

    this.onConfigChange = (values, previous) => {
      describeChanges(values, previous);

      const voiceChanged =
        values.ttsProvider !== previous.ttsProvider ||
        values.ttsVoice !== previous.ttsVoice ||
        values.ttsLocalVoice !== previous.ttsLocalVoice;
      if (voiceChanged) warmFillers().catch(() => {});

      // A provider or key change is exactly the fix someone reaches for after
      // transcription failed, so it has to clear the latch that failure set.
      const hearingChanged =
        values.sttProvider !== previous.sttProvider ||
        values.sttLocalModel !== previous.sttLocalModel ||
        values.openaiApiKey !== previous.openaiApiKey;

      for (const session of this.sessions.values()) {
        session.receiver?.setWindow(values.bufferSeconds);
        if (hearingChanged) session.eager?.reset();
      }

      // Listening is a panel switch now, so it has to reach a session already
      // in a channel — otherwise it would set the value for the *next* join
      // and appear to do nothing, which is the kind of control that teaches
      // people not to trust the panel.
      if (values.agentEnabled !== previous.agentEnabled) {
        for (const session of this.sessions.values()) {
          session
            .setAgentEnabled(values.agentEnabled)
            .catch((err) => console.warn(`[voice] could not change listening: ${err.message}`));
        }
      }
    };
    config.on('change', this.onConfigChange);

    // A reminder came due. This is the one place the bot speaks without
    // having just been spoken to — the agent composed the sentence when the
    // reminder was set; all that's left is to say it.
    this.onReminderFire = async ({ guildId, id, message }) => {
      const session = this.sessions.get(guildId);
      if (!session || session.destroyed) {
        console.warn(`[reminders] #${id} fired but the bot is no longer in a channel — dropped: "${message}"`);
        return;
      }
      // Music mode: still a promise the bot made, so it is kept — written
      // where the room is already reading about the music rather than spoken
      // over the song. Never held back to be said once the mode ends: a
      // reminder said half an hour late is worse than one not said at all,
      // which is the same rule as one that came due while the process was down.
      if (session.quiet) {
        const wrote = await noteInMusicChannel(
          { guild: () => session.client?.guilds?.cache?.get(guildId) ?? null },
          `⏰  ${message}`,
        );
        console.log(
          wrote
            ? `[reminders] #${id} written in the music channel, not spoken: "${message}"`
            : `[reminders] #${id} came due in music mode with no music channel to write it in — dropped: "${message}"`,
        );
        return;
      }
      try {
        const tts = createTts();
        const audio = await tts.synthesizeStream(clampForSpeech(message));
        // If it's mid-answer, let the sentence finish — an alarm that talks
        // over the answer to someone else's question serves nobody.
        if (session.speaking) {
          await entersState(session.player, AudioPlayerStatus.Idle, 15_000).catch(() => {});
        }
        session.player.stop(true);
        session.player.play(toAudioResource(audio));
        console.log(`[reminders] #${id} spoken: "${message}"`);
      } catch (err) {
        console.warn(`[reminders] #${id} could not be spoken: ${err.message}`);
      }
    };
    reminders.on('fire', this.onReminderFire);
  }

  /**
   * Detach from the two process-wide emitters.
   *
   * The singleton below never needs this — it lives as long as the process.
   * A second instance does, or it keeps answering config changes and reminders
   * for sessions nobody is in.
   */
  dispose() {
    config.off('change', this.onConfigChange);
    reminders.off('fire', this.onReminderFire);
    this.leaveAll();
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

    const session = this.createSession(channel);
    this.sessions.set(channel.guild.id, session);

    session.on('destroyed', () => {
      // Inside the identity check, not beside it. This event arrives from the
      // voice connection's state handler, so it is late: moving the bot between
      // channels destroys session A, builds B, pre-warms B's agent, and only
      // then hears A's 'destroyed'. Ending the agent unconditionally there
      // killed the session that had just been prepared for B.
      if (this.sessions.get(channel.guild.id) !== session) {
        this.emit('update');
        return;
      }
      this.sessions.delete(channel.guild.id);
      // The agent session's memory is that conversation; when the bot leaves
      // the channel, the conversation is over.
      endAgentSession(channel.guild.id);
      forgetCascade(channel.guild.id);
      this.emit('update');
    });
    session.on('update', () => this.emit('update'));

    // Someone said the wake phrase out loud. This is the whole point.
    session.on('wake', async ({ question, askedBy, askedById, heard, stoppedAt, marks, viaFollowUp }) => {
      console.log(`[wake] ${askedBy}: "${heard}"`);
      try {
        const result = await ask(session, { question, askedBy, askedById, stoppedAt, marks, viaFollowUp });
        console.log(`[wake] answered: "${result.spoken}"`);
        // If it ended by asking something, the person it asked can answer
        // without saying its name again. Set after playback rather than
        // before: until the answer has been heard there is nothing to reply to.
        if (session.expectReply(askedById, result.spoken)) {
          console.log('[wake] it asked something — listening for the answer without the name');
        }
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
      throw new Error(`Could not connect to ${channel.name}: ${err.message}`, { cause: err });
    }

    // Nobody is waiting yet, so this is the cheapest moment to absorb the
    // agent session's startup.
    this.warmAgent(channel.guild.id);

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
    // session.status() already carries the panel's compact `music` summary —
    // musicStatus() is the richer shape the voice tools and /mj queue read,
    // kept on the session itself rather than duplicated here.
    return this.list().map((s) => s.status());
  }
}

/**
 * Say out loud when a provider changes.
 *
 * Switching these from the panel used to be silent, so there was no way to tell
 * from the console whether a setting had taken, whether a model was loading, or
 * whether it had quietly fallen back.
 */
export function describeChanges(values, previous) {
  if (
    values.sttProvider !== previous.sttProvider ||
    values.sttLocalModel !== previous.sttLocalModel ||
    values.sttModel !== previous.sttModel
  ) {
    console.log(
      `[config] hearing → ${values.sttProvider === 'local' ? `whisper.cpp ${values.sttLocalModel} (this machine)` : `OpenAI ${values.sttModel} (API)`}`,
    );
  }
  if (
    values.ttsProvider !== previous.ttsProvider ||
    values.ttsVoice !== previous.ttsVoice ||
    values.ttsModel !== previous.ttsModel ||
    values.ttsSpeed !== previous.ttsSpeed ||
    values.ttsLocalVoice !== previous.ttsLocalVoice
  ) {
    console.log(
      `[config] speaking → ${values.ttsProvider === 'local' ? `Piper ${values.ttsLocalVoice} (this machine)` : `OpenAI ${values.ttsModel} ${values.ttsVoice}${Number(values.ttsSpeed) !== 1 ? ` ×${values.ttsSpeed}` : ''} (API)`}`,
    );
  }
  if (
    values.brainKind !== previous.brainKind ||
    values.brainProvider !== previous.brainProvider ||
    values.brainModel !== previous.brainModel ||
    values.fastModel !== previous.fastModel ||
    values.webSearch !== previous.webSearch ||
    values.mcpServers !== previous.mcpServers
  ) {
    if (values.brainKind === 'cascade') {
      console.log(
        `[config] thinking → ${values.fastModel || 'gpt-4.1'} in front of Claude agent ${values.brainModel || 'claude-sonnet-5'}${values.webSearch ? ' + web search' : ''}`,
      );
    } else if (values.brainKind === 'agent') {
      let mcp = 'no MCP servers';
      try {
        const names = Object.keys(JSON.parse(values.mcpServers || '{}'));
        if (names.length) mcp = `MCP: ${names.join(', ')}`;
      } catch { mcp = 'MCP config has a JSON error'; }
      // The agent runs on whichever provider the model id belongs to, so the
      // line has to name the one it will actually start rather than assume.
      const model = values.brainModel || 'claude-sonnet-5';
      const provider = providerFor(model) === 'openai' ? 'OpenAI' : 'Claude';
      console.log(
        `[config] thinking → ${provider} agent ${model} (${mcp})${values.webSearch ? ' + web search' : ''}`,
      );
    } else {
      const model = values.brainModel || (values.brainProvider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-5');
      console.log(
        `[config] thinking → ${values.brainProvider} ${model}${values.webSearch ? ' + web search' : ''}`,
      );
    }
  }
  if (values.agentNames !== previous.agentNames) {
    console.log(`[config] answers to → ${values.agentNames}`);
  }
}

export const sessionManager = new SessionManager();
