import { EventEmitter } from 'node:events';

import { config } from '../config.js';
import { VoiceSession } from './session.js';
import { AudioPlayerStatus, entersState } from '@discordjs/voice';

import { ask, AgentBusyError } from '../agent/index.js';
import { endAgentSession, warmAgentSession } from '../agent/agent-brain.js';
import { reminders } from '../agent/reminders.js';
import { createTts, toAudioResource } from '../agent/tts.js';
import { clampForSpeech } from '../agent/brain.js';
import { warmFillers } from '../agent/filler.js';

/** Tracks one VoiceSession per guild. */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();

    config.on('change', (values, previous) => {
      describeChanges(values, previous);

      const voiceChanged =
        values.ttsProvider !== previous.ttsProvider ||
        values.ttsVoice !== previous.ttsVoice ||
        values.ttsLocalVoice !== previous.ttsLocalVoice;
      if (voiceChanged) warmFillers().catch(() => {});

      for (const session of this.sessions.values()) {
        // Volume is worth applying mid-sentence.
        session.applyVolume(values.volume);
        session.receiver?.setWindow(values.bufferSeconds);
      }
    });

    // A reminder came due. This is the one place the bot speaks without
    // having just been spoken to — the agent composed the sentence when the
    // reminder was set; all that's left is to say it.
    reminders.on('fire', async ({ guildId, id, message }) => {
      const session = this.sessions.get(guildId);
      if (!session || session.destroyed) {
        console.warn(`[reminders] #${id} fired but the bot is no longer in a channel — dropped: "${message}"`);
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
      // The agent session's memory is that conversation; when the bot leaves
      // the channel, the conversation is over.
      endAgentSession(channel.guild.id);
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

    // Nobody is waiting yet, so this is the cheapest moment to absorb the
    // agent session's startup.
    warmAgentSession(channel.guild.id);

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

/**
 * Say out loud when a provider changes.
 *
 * Switching these from the panel used to be silent, so there was no way to tell
 * from the console whether a setting had taken, whether a model was loading, or
 * whether it had quietly fallen back.
 */
function describeChanges(values, previous) {
  if (values.sttProvider !== previous.sttProvider || values.sttLocalModel !== previous.sttLocalModel) {
    console.log(
      `[config] hearing → ${values.sttProvider === 'local' ? `whisper.cpp ${values.sttLocalModel} (this machine)` : 'OpenAI whisper-1 (API)'}`,
    );
  }
  if (values.ttsProvider !== previous.ttsProvider || values.ttsVoice !== previous.ttsVoice || values.ttsLocalVoice !== previous.ttsLocalVoice) {
    console.log(
      `[config] speaking → ${values.ttsProvider === 'local' ? `Piper ${values.ttsLocalVoice} (this machine)` : `OpenAI tts-1 ${values.ttsVoice} (API)`}`,
    );
  }
  if (
    values.brainKind !== previous.brainKind ||
    values.brainProvider !== previous.brainProvider ||
    values.brainModel !== previous.brainModel ||
    values.webSearch !== previous.webSearch ||
    values.mcpServers !== previous.mcpServers
  ) {
    if (values.brainKind === 'agent') {
      let mcp = 'no MCP servers';
      try {
        const names = Object.keys(JSON.parse(values.mcpServers || '{}'));
        if (names.length) mcp = `MCP: ${names.join(', ')}`;
      } catch { mcp = 'MCP config has a JSON error'; }
      console.log(
        `[config] thinking → Claude agent ${values.brainModel || 'claude-sonnet-5'} (${mcp})${values.webSearch ? ' + web search' : ''}`,
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
