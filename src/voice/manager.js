import { EventEmitter } from 'node:events';

import { config } from '../config.js';
import { VoiceSession } from './session.js';
import { AudioPlayerStatus, entersState } from '@discordjs/voice';

import { ask, AgentBusyError, whenIdle as askWhenIdle } from '../agent/index.js';
import { endAgentSession, warmAgentSession } from '../agent/agent-brain.js';
import { recapCall } from '../agent/recap.js';
import { presence, rejoinRecent } from './presence.js';
import { forgetCascade } from '../agent/cascade.js';
import { providerFor } from '../agent/models.js';
import { modeByName } from '../agent/modes.js';
import { reminders } from '../agent/reminders.js';
import { lateAnswers } from '../agent/tools/zomboid.js';
import { noteInMusicChannel } from '../agent/tools/music.js';
import { createTts, toAudioResource } from '../agent/tts.js';
import { clampForSpeech } from '../agent/brain.js';
import { warmFillers } from '../agent/filler.js';

/**
 * How long a held wake is still worth answering.
 *
 * An answer takes ~12s median from question to end of playback, so this only
 * has to cover the one answer that was already in flight when the held wake
 * arrived. Any older than that and the room has moved on — replaying it would
 * be the bot suddenly answering a question from two topics ago, which is a
 * stranger experience than the silence it replaces.
 *
 * Exported (and, on the manager, overridable via the constructor) so a test
 * can prove the drop without actually waiting fifteen seconds for it.
 */
export const HELD_WAKE_MAX_AGE_MS = 15_000;

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
    askFn = ask,
    heldWakeMaxAgeMs = HELD_WAKE_MAX_AGE_MS,
    whenIdle = askWhenIdle,
  } = {}) {
    super();
    this.sessions = new Map();
    this.createSession = createSession;
    // Injected for the same reason as createSession, and it matters more:
    // unstubbed, joining a channel starts a real Agent SDK subprocess holding
    // about a gigabyte. A test for a Map should not do that.
    this.warmAgent = warmAgent;
    // Injected so a test can control exactly when a wake's ask() resolves
    // and when it throws AgentBusyError — the real one goes through the
    // brain, the TTS and the transcriber, none of which a held-wake test has
    // any business starting.
    this.askFn = askFn;
    // Same idea again: production waits fifteen real seconds before giving up
    // on a held wake, and a test proving that drop should not have to.
    this.heldWakeMaxAgeMs = heldWakeMaxAgeMs;
    // Paired with askFn rather than always the real agent/index.js export:
    // whenIdle() answers out of the real module's own `inFlight` set, which a
    // fake askFn used in a drain() test never touches. Production leaves
    // both at their real defaults, which do share that set.
    this.whenIdle = whenIdle;
    // Set by drain() on the way into shutdown — see there. Refuses new wakes
    // (handleWake, below) and drops speakUnprompted's reminders and late
    // answers: nobody still on the call once the process has logged
    // "shutting down" is going to hear either played back after it exits.
    this.draining = false;

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

    // A reminder came due. One of the few places the bot speaks without having
    // just been spoken to — the agent composed the sentence when the reminder
    // was set; all that's left is to say it.
    this.onReminderFire = ({ guildId, id, message }) =>
      this.speakUnprompted(guildId, message, `[reminders] #${id}`);

    reminders.on('fire', this.onReminderFire);

    // A door that took its time answering finally did — see zomboid.js. The
    // turn that asked already told the room "te aviso" and ended; this is
    // the same unprompted path a reminder uses to say the rest once it's in.
    this.onLateZomboidAnswer = ({ guildId, spoken }) =>
      this.speakUnprompted(guildId, spoken, '[zomboid] late answer', '🧟');

    lateAnswers.on('late', this.onLateZomboidAnswer);
  }

  /**
   * Detach from the process-wide emitters.
   *
   * The singleton below never needs this — it lives as long as the process.
   * A second instance does, or it keeps answering config changes, reminders
   * and late zomboid answers for sessions nobody is in.
   */
  dispose() {
    config.off('change', this.onConfigChange);
    reminders.off('fire', this.onReminderFire);
    lateAnswers.off('late', this.onLateZomboidAnswer);
    this.leaveAll();
  }

  get(guildId) {
    return this.sessions.get(guildId) ?? null;
  }

  list() {
    return [...this.sessions.values()];
  }

  /** Join (or move to) a voice channel and return the ready session. */
  /**
   * Say something into the channel that nobody just asked for.
   *
   * The bot speaks when spoken to, with a growing list of exceptions: a
   * reminder coming due, a mode ending on its own, and — see
   * docs/plans/personalities.md — something a mode was watching finishing,
   * which now includes a zomboid door answering after its own turn already
   * ended (zomboid.js, `lateAnswers`).
   * They all need the same four decisions, which is why they share one path:
   * drop it when the bot has left, write it instead of speaking it when the
   * room has asked for quiet, wait for a sentence in flight, and go out
   * through the speech queue rather than the player, so the music is paused
   * and handed back properly.
   *
   * `tag` is how it is logged, e.g. "[reminders] #3"; `prefix` is what marks
   * it in the text channel when it has to be written rather than said.
   */
  async speakUnprompted(guildId, message, tag, prefix = '⏰') {
    // A reminder or a late answer that comes due while shutdown is draining
    // has nobody left to speak to by the time it would play — the process is
    // on its way out. Not persisted for the next start: reminders re-arm
    // themselves if their own code does that, and this is not the place to
    // add a second mechanism for it.
    if (this.draining) {
      console.log(`${tag} came due while shutting down — dropped: "${message}"`);
      return false;
    }
    const session = this.sessions.get(guildId);
    if (!session || session.destroyed) {
      console.warn(`${tag} came due but the bot is no longer in a channel — dropped: "${message}"`);
      return false;
    }
    // Music mode: still a promise the bot made, so it is kept — written
    // where the room is already reading about the music rather than spoken
    // over the song. Never held back to be said once the mode ends: a
    // reminder said half an hour late is worse than one not said at all,
    // which is the same rule as one that came due while the process was down.
    if (session.quiet) {
      const wrote = await noteInMusicChannel(
        { guild: () => session.client?.guilds?.cache?.get(guildId) ?? null },
        `${prefix}  ${message}`,
      );
      console.log(
        wrote
          ? `${tag} written in the music channel, not spoken: "${message}"`
          : `${tag} came due in music mode with no music channel to write it in — dropped: "${message}"`,
      );
      return false;
    }
    try {
      // A character's own voice is most of what makes it audible as somebody
      // else — see `voice()`/`mouthpiece()` in agent/index.js, which do the
      // same lookup per sentence inside a turn. This is a single sentence
      // spoken outside any turn, so one lookup at the top is enough; without
      // it a late zomboid answer would come back in the room's usual voice
      // wearing somebody else's words.
      const mode = modeByName(session.mode);
      const tts = createTts(mode?.voice ? { voice: mode.voice } : undefined);
      const audio = await tts.synthesizeStream(clampForSpeech(message));
      // If it's mid-answer, let the sentence finish — an alarm that talks
      // over the answer to someone else's question serves nobody.
      if (session.speaking) {
        await entersState(session.player, AudioPlayerStatus.Idle, 15_000).catch(() => {});
      }
      // Through the same door as every answer: startSpeech pauses the music
      // and hands the connection to the speaking player, then hands it back.
      // Playing on session.player directly, as this did, went to a player
      // the connection was not listening to whenever a song was on.
      const speech = session.startSpeech();
      speech.push(toAudioResource(audio), message);
      speech.end();
      await speech.finished;
      console.log(`${tag} spoken: "${message}"`);
    } catch (err) {
      console.warn(`${tag} could not be spoken: ${err.message}`);
    }
    return true;
  }

  async join(channel) {
    const existing = this.sessions.get(channel.guild.id);
    if (existing && !existing.destroyed) {
      if (existing.channelId === channel.id) return existing;
      existing.destroy();
      this.sessions.delete(channel.guild.id);
    }

    const session = this.createSession(channel);
    this.sessions.set(channel.guild.id, session);
    // Written down so a restart can put the bot back; see presence.js.
    presence.remember(channel.guild.id, channel.id);

    session.on('destroyed', () => {
      // Whatever this session was holding dies with it — answering a held
      // wake into a channel the bot already left makes no sense, and nothing
      // else ever clears this closure's slot.
      heldWake = null;
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
      // Before the conversation is forgotten, the two or three things worth
      // keeping from it go into the notebook. Fire and forget: nobody is
      // waiting, and a failure here is a missed note, not a broken bot.
      recapCall({ exchanges: session.recentExchanges }).catch((err) => {
        console.warn(`[notebook] end-of-call recap failed: ${err.message}`);
      });
      // The agent session's memory is that conversation; when the bot leaves
      // the channel, the conversation is over.
      endAgentSession(channel.guild.id);
      forgetCascade(channel.guild.id);
      this.emit('update');
    });
    session.on('update', () => this.emit('update'));

    // Someone said the wake phrase out loud. This is the whole point.
    //
    // ask() allows one request in flight per guild and throws AgentBusyError
    // for a second caller; this used to just drop that second one. Measured
    // over five days of production logs (2026-09-06..10) that dropped 54 real
    // questions — "¿podemos hablar en inglés de ahora en más, por favor?",
    // "qué es esto que estás haciendo ahora?" — asked while an answer that
    // takes ~12s median from question to end of playback was still being
    // spoken. Instead of dropping it, the latest one heard while busy is
    // held — one slot, a newer one replaces an older one — and answered
    // through this same handler once the in-flight ask() settles, success or
    // failure alike, as long as it is still fresh enough (heldWakeMaxAgeMs)
    // to be worth answering.
    let heldWake = null;

    /**
     * Handle a wake, or replay one that was held.
     *
     * `held` is only true on the replay call: it skips the "arrived" log
     * line, already printed when the wake first came in, and if ask() is
     * somehow still busy — it shouldn't be, since the slot is freed in
     * ask()'s `finally` before a held wake is ever replayed, but be
     * defensive — drops it rather than holding it again, so a held question
     * can never end up waiting behind its own replacement.
     */
    const handleWake = async (wake, { held = false } = {}) => {
      const { question, askedBy, askedById, heard, stoppedAt, marks, viaFollowUp } = wake;
      // Shutting down: refuse a fresh wake, and — since a held wake is
      // replayed through this same function once its slot frees — this also
      // catches the one already waiting when the drain began, dropping it
      // rather than starting a new ask() after drain() has stopped counting.
      if (this.draining) {
        console.log(`[wake] ${askedBy}: "${heard}" — ignored, shutting down`);
        return;
      }
      if (!held) console.log(`[wake] ${askedBy}: "${heard}"`);
      try {
        const result = await this.askFn(session, { question, askedBy, askedById, stoppedAt, marks, viaFollowUp });
        console.log(`[wake] answered: "${result.spoken}"`);
        // If it ended by asking something, the person it asked can answer
        // without saying its name again. Set after playback rather than
        // before: until the answer has been heard there is nothing to reply to.
        if (session.expectReply(askedById, result.spoken)) {
          console.log('[wake] it asked something — listening for the answer without the name');
        }
      } catch (err) {
        // Don't speak errors into the channel — that's worse than silence.
        if (err instanceof AgentBusyError) {
          if (held) {
            console.log(`[wake] ${askedBy}'s held question hit a busy agent — dropped: "${heard}"`);
          } else {
            if (heldWake) {
              console.log(`[wake] ${heldWake.askedBy} asked while it was still answering — dropped: "${heldWake.heard}"`);
            }
            // Aged from stoppedAt — when the person actually stopped talking
            // — rather than from now: the busy check that just caught this
            // already ran some way behind that moment, and heldWakeMaxAgeMs
            // is a budget for the question's own age, not for how long the
            // busy check took to notice.
            heldWake = { ...wake, askedAt: stoppedAt ?? Date.now() };
            console.log(`[wake] ${askedBy} asked while it was still answering — held: "${heard}"`);
          }
          return;
        }
        // Anything else still frees the slot below in ask()'s `finally`,
        // same as a success — 19 of these in five days, and more once the
        // credit problem lands, so a held wake must not starve behind one.
        console.warn(`[wake] could not answer: ${err.message}`);
      }

      // The slot this call held just freed up in ask()'s `finally` — if
      // something was waiting on it, this is its turn.
      if (!heldWake) return;
      const next = heldWake;
      heldWake = null;
      if (Date.now() - next.askedAt > this.heldWakeMaxAgeMs) {
        console.log(`[wake] dropped ${next.askedBy}'s held question, too old`);
        return;
      }
      console.log(`[wake] answering ${next.askedBy}'s held question`);
      await handleWake(next, { held: true });
    };

    session.on('wake', handleWake);

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

  /**
   * Leave a channel. Asked to, by voice, command or panel, the channel is
   * forgotten; `{ comingBack: true }` is the shutdown's version, which keeps it
   * so the next start can return.
   */
  leave(guildId, { comingBack = false } = {}) {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    if (!comingBack) presence.forget(guildId);
    session.destroy();
    this.sessions.delete(guildId);
    this.emit('update');
    return true;
  }

  leaveAll({ comingBack = false } = {}) {
    for (const guildId of [...this.sessions.keys()]) this.leave(guildId, { comingBack });
  }

  /**
   * Let whatever is already in progress finish before shutdown tears
   * everything down.
   *
   * AUDIT.md: `leaveAll` reaches `session.destroy()`, which cancels speech
   * and stops the player unconditionally — "a deploy that lands while the
   * bot is mid-answer cuts it off mid-word every time." This runs first, so
   * by the time destroy() gets to a session there is nothing left in it to
   * cut off.
   *
   * Setting `draining` refuses a fresh wake and drops one already held (see
   * handleWake in join()) and drops a reminder or late answer coming due
   * (speakUnprompted) — none of which anyone is going to hear the far side
   * of a process that has already logged "shutting down". Then, for every
   * session, this waits for (a) whatever ask() is running for that guild to
   * settle — whenIdle(), the same slot handleWake's own held-wake replay
   * waits on — and (b) its speech queue to finish saying what it already
   * has, which is what catches the paths that never go through ask() at
   * all: a reminder, a late zomboid answer, already playing when the signal
   * arrived. Bounded by `timeoutMs` as a whole, not per session, so one
   * wedged guild cannot eat the whole budget and leave the others cut off
   * anyway.
   */
  async drain({ timeoutMs }) {
    this.draining = true;
    const sessions = this.list();

    const settled = Promise.all(
      sessions.map((session) =>
        Promise.all([this.whenIdle(session.guildId), session.speech?.drained() ?? Promise.resolve()]),
      ),
    ).then(() => true);

    const timedOut = new Promise((resolve) => {
      setTimeout(() => resolve(false), timeoutMs).unref();
    });

    const finishedInTime = sessions.length === 0 ? true : await Promise.race([settled, timedOut]);
    console.log(
      finishedInTime
        ? '[shutdown] every session finished what it was saying'
        : `[shutdown] drain timed out after ${timeoutMs}ms — at least one session may still have been mid-sentence`,
    );
  }

  /** After a restart: back into the channels it was in, if anyone is still there. */
  rejoin(client) {
    return rejoinRecent(presence, {
      fetchChannel: async (id) => {
        const channel = await client.channels.fetch(id).catch(() => null);
        return channel?.isVoiceBased?.() ? channel : null;
      },
      join: (channel) => this.join(channel),
    });
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
