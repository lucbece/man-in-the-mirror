import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

import { config } from '../config.js';
import { SpeechQueue } from './speech-queue.js';
import { MusicPlayer } from './music.js';
import { VoiceReceiver } from './receiver.js';
import { EagerTranscriber } from '../agent/eager.js';
import { detectAddress, normalise, splitNames } from '../agent/wake.js';

const READY_TIMEOUT_MS = 20_000;

/** Ignore a repeat wake this soon after the last one. */
const WAKE_COOLDOWN_MS = 4_000;

/**
 * How long to wait for more of the question after the speaker pauses.
 *
 * An utterance ends after half a second of silence, which is shorter than the
 * pause people leave mid-sentence — so without this, "espejo, qué opinás
 * de… los servidores?" would be cut off at the ellipsis. Every further
 * utterance from the same person restarts this clock.
 *
 * Every millisecond here is dead air before the reply, so it's as short as it
 * can be while still surviving a breath.
 */
const WAKE_GRACE_MS = 900;

/**
 * Longer wait when the phrase arrived with nothing after it. "Hey mirror…"
 * followed by a beat and then the actual question is how people naturally
 * address something, and it deserves more patience than a trailing pause.
 */
const WAKE_OPEN_MS = 6_000;

/**
 * How long to wait for someone *else* who is still mid-sentence.
 *
 * A call is not two people taking turns. Somebody asks "cuánto tardamos
 * manejando" and, over the top of them, another says "a Bariloche" and a third
 * "saliendo de noche" — the question finished by the room rather than by the
 * asker.
 *
 * An utterance only reaches the buffer once its speaker has been quiet for
 * SILENCE_MS, and the answer is assembled from the buffer. So anyone still
 * talking when the grace timer fires was not late to the answer — they were
 * absent from it, and nothing downstream could tell.
 *
 * Only paid when somebody else is genuinely speaking at that moment, and it
 * ends the instant they stop rather than running the clock out.
 */
const WAKE_SETTLE_MS = 1_500;

/**
 * How long a question the bot asked stays open for its answer.
 *
 * When the bot ends its reply with a question — "¿desde qué ciudad?" — it is
 * waiting for something, and making the person say its name again to hand it
 * over is a bug in the conversation rather than a policy. So for a short while
 * afterwards, the next thing *that person* says counts as addressing it.
 *
 * Deliberately narrow, because the cost of being wrong here is the one failure
 * that gets a bot removed from a server: speaking when nobody asked. It only
 * opens when the bot actually asked something, only for the person it asked,
 * and it is spent on the first thing they say.
 */
const REPLY_WINDOW_MS = 12_000;

/**
 * Exported as a mutable object so tests can shrink the waits. Everything below
 * reads through it rather than closing over the constants.
 */
export const WAKE_TIMING = {
  cooldownMs: WAKE_COOLDOWN_MS,
  graceMs: WAKE_GRACE_MS,
  openMs: WAKE_OPEN_MS,
  settleMs: WAKE_SETTLE_MS,
  replyMs: REPLY_WINDOW_MS,
};

/** Did the bot's own reply end by asking something? */
export function endsWithQuestion(text) {
  const trimmed = String(text ?? '').trim().replace(/["'»)\]]+$/, '');
  return trimmed.endsWith('?');
}

/**
 * One guild's voice presence: the connection, the player it speaks through, and
 * the receiver it listens with.
 */
export class VoiceSession extends EventEmitter {
  constructor(channel) {
    super();
    this.guildId = channel.guild.id;
    this.channelId = channel.id;
    this.channelName = channel.name;
    this.guildName = channel.guild.name;
    this.client = channel.client;

    this.destroyed = false;

    // Kept for the agent's own voice — TTS output plays through here.
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });

    this.player.on('error', (err) => {
      console.error(`[voice:${this.guildId}] player error: ${err.message}`);
      this.emit('error', err);
    });

    this.player.on(AudioPlayerStatus.Idle, () => this.emit('update'));

    // Self-deafening is what stops Discord sending us any audio at all. While
    // listening is off we stay deafened — and Discord shows the deafened icon
    // next to the bot, so "can this thing hear me?" is answered in the member
    // list rather than by trusting us.
    this.agentEnabled = config.get('agentEnabled');

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: !this.agentEnabled,
      selfMute: false,
    });

    // Music has its own player: a connection carries one at a time, so the
    // two take turns rather than mixing. See voice/music.js.
    this.music = new MusicPlayer();
    this.music.on('update', () => {
      this.emit('update');
      // Music nobody handed the connection to plays to an empty room. Before
      // this, the handover only ran when a *speech* ended — so the moment
      // music commands stopped being announced, they stopped being audible.
      if (this.music.playing && !this.speech) this.#handMouthTo('music');
    });
    this.subscription = this.connection.subscribe(this.player);
    this.attachConnectionHandlers();

    this.receiver = new VoiceReceiver(this.connection, {
      guildId: this.guildId,
      client: this.client,
      windowSeconds: config.get('bufferSeconds'),
    });

    /**
     * Music mode: the bot hears and acts as usual, and says nothing at all.
     *
     * A property of the session rather than of the configuration, because it
     * is about this room and this song. Leaving the channel is the end of it,
     * which is also the only way it can be forgotten by accident.
     */
    this.quiet = false;

    this.eager = null;
    this.lastWakeAt = 0;
    // Set when the bot ends a reply with a question: whose answer it is
    // waiting for, and until when.
    this.awaitingReply = null;
    /** Set while we're still hearing out someone's question. */
    this.pendingWake = null;
    this.receiver.on('utterance', (utterance) => this.onUtterance(utterance));
  }

  // --- eager transcription and waking ---------------------------------------

  onUtterance(utterance) {
    if (!config.get('eagerTranscription')) return;

    this.eager ??= this.createEager();
    this.eager.push(utterance);
  }

  createEager() {
    const eager = new EagerTranscriber({ label: `:${this.guildId}` });
    eager.on('transcribed', (utterance) => this.checkForWake(utterance));
    return eager;
  }

  /**
   * A freshly transcribed utterance is the only place a wake phrase can appear,
   * so this is where the bot decides it's being spoken to.
   */
  /**
   * Is this the answer to a question the bot just asked?
   *
   * Spent on the first thing that person says, so a window cannot linger and
   * catch an unrelated sentence a minute later. Somebody *else* speaking does
   * not spend it — they are not who was asked.
   */
  takeExpectedReply(utterance) {
    const expected = this.awaitingReply;
    if (!expected) return false;
    if (Date.now() > expected.until) {
      this.awaitingReply = null;
      return false;
    }
    if (utterance.userId !== expected.userId || !utterance.text?.trim()) return false;
    this.awaitingReply = null;
    return true;
  }

  /**
   * The bot has finished speaking. If it ended by asking something, the person
   * it asked may answer without saying its name again.
   */
  expectReply(userId, spoken) {
    this.awaitingReply =
      userId && endsWithQuestion(spoken)
        ? { userId, until: Date.now() + WAKE_TIMING.replyMs }
        : null;
    return Boolean(this.awaitingReply);
  }

  checkForWake(utterance) {
    if (!config.get('wakeEnabled') || this.destroyed) return;

    // Already listening to someone's question — this is more of it, not a new one.
    if (this.pendingWake) return this.extendWake(utterance);

    // Answering the bot's own question counts as addressing it. No cooldown
    // check on this path: it is a continuation the bot asked for, not somebody
    // triggering it twice.
    const answeringUs = this.takeExpectedReply(utterance);

    if (!answeringUs) {
      const { matched, name, closest } = detectAddress(utterance.text, config.get('agentNames'));
      if (!matched) {
        // A near miss is almost always transcription mangling the name, which is
        // invisible otherwise — the bot just sits there saying nothing.
        if (closest && closest.score >= 0.55) {
          console.log(
            `[wake] near miss: heard "${closest.heard}" vs "${closest.name}" ` +
              `(${closest.score.toFixed(2)}) in: "${utterance.text}"`,
          );
        }
        return;
      }
      console.log(`[wake] addressed as "${name}" in: "${utterance.text}"`);

      // Someone saying the phrase twice in quick succession means one answer,
      // not two talking over each other.
      const now = Date.now();
      if (now - this.lastWakeAt < WAKE_TIMING.cooldownMs) return;
      this.lastWakeAt = now;
    } else {
      console.log(`[wake] ${utterance.displayName} answered the question it asked: "${utterance.text}"`);
      this.lastWakeAt = Date.now();
    }

    // The whole sentence is the request. The name can sit anywhere in it —
    // "mirror, what do you think" and "what do you think, mirror" are the same
    // ask — so slicing at the name would throw away half of them.
    this.pendingWake = {
      userId: utterance.userId,
      askedBy: utterance.displayName,
      parts: [utterance.text.trim()],
      heard: utterance.text,
      timer: null,
      // When they actually stopped talking. Everything between here and the
      // first spoken word is overhead the room experiences as the bot being
      // slow — silence detection, transcription, the grace wait — and none of
      // it was ever measured, only chosen. See AUDIT.md.
      stoppedAt: utterance.endedAt ?? Date.now(),
      // Came from the bot's own question rather than from its name, so the
      // panel can show how often that path fires — and whether it fires wrongly.
      viaFollowUp: answeringUs,
    };
    // Just its name and nothing else means they're winding up to ask.
    const onlyTheName = normalise(utterance.text).split(' ').length <= 2;
    this.armWake(onlyTheName ? WAKE_TIMING.openMs : WAKE_TIMING.graceMs);
  }

  /**
   * The speaker kept talking. Append it and restart the clock, so a question
   * with a pause in the middle of it doesn't get cut in half.
   */
  extendWake(utterance) {
    const pending = this.pendingWake;
    if (utterance.userId !== pending.userId) return; // someone else talking over
    if (!utterance.text.trim()) return;

    pending.parts.push(utterance.text.trim());
    pending.heard += ` ${utterance.text.trim()}`;
    pending.stoppedAt = utterance.endedAt ?? Date.now();
    this.armWake(WAKE_TIMING.graceMs);
  }

  /** (Re)start the "have they finished talking?" timer. */
  armWake(delayMs) {
    const pending = this.pendingWake;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.fireWake(), delayMs);
    pending.timer.unref?.();
  }

  /**
   * Wait for anyone else who is still talking, so their words are in the
   * buffer by the time the answer is assembled from it.
   *
   * Resolves as soon as nobody else is mid-utterance, so the common case —
   * one person asking into a quiet moment — costs nothing at all.
   */
  settleOtherSpeakers(askerId) {
    const stillTalking = () =>
      [...(this.receiver?.active?.keys() ?? [])].filter((id) => id !== askerId);

    const waitingFor = stillTalking();
    if (!waitingFor.length) return Promise.resolve(0);

    const startedAt = Date.now();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.receiver.off('utterance', check);
        resolve(Date.now() - startedAt);
      };
      const check = () => {
        if (!stillTalking().length) finish();
      };
      const timer = setTimeout(finish, WAKE_TIMING.settleMs);
      timer.unref?.();
      this.receiver.on('utterance', check);
    });
  }

  async fireWake() {
    const pending = this.pendingWake;
    this.pendingWake = null;
    if (!pending || this.destroyed) return;

    // Before reading the buffer, let the rest of the room finish landing in it.
    const waited = await this.settleOtherSpeakers(pending.userId);
    if (this.destroyed) return;
    if (waited) {
      console.log(`[wake] waited ${waited}ms for someone else to finish talking`);
    }

    const question = pending.parts.join(' ').trim();

    // Someone said its name and nothing else. Handing the model the single
    // word "mirror" as a question invites it to invent one, so say plainly
    // that there wasn't one.
    const bareSummon = normalise(question)
      .split(' ')
      .filter((word) => !splitNames(config.get('agentNames')).some((n) => normalise(n) === word))
      .join('')
      .length === 0;

    this.emit('wake', {
      question:
        bareSummon || !question
          ? 'They said your name but nothing else. Ask what they want, in a few words.'
          : question,
      askedBy: pending.askedBy,
      stoppedAt: pending.stoppedAt,
      viaFollowUp: pending.viaFollowUp,
      // Discord attributes this to the audio stream it arrived on, so it is
      // the one part of a spoken request that can't be claimed by saying it.
      // Every permission check downstream rests on that.
      askedById: pending.userId,
      heard: pending.heard,
    });
  }

  cancelWake() {
    if (this.pendingWake?.timer) clearTimeout(this.pendingWake.timer);
    this.pendingWake = null;
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
      this.destroyed = true;
      this.emit('destroyed');
    });
  }

  async waitUntilReady() {
    await entersState(this.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    // Which of Discord's voice servers carries this call decides the audio
    // leg of every answer's latency, and it is Discord's choice, not ours. The
    // hostname is in the VOICE_SERVER_UPDATE data that @discordjs/voice keeps
    // as `connectionOptions` on its networking state — the only public route
    // to it (the raw packet is private). Just the host: the same object holds
    // the voice token.
    const endpoint = this.connection.state.networking?.state?.connectionOptions?.endpoint;
    if (endpoint) console.log(`[voice] endpoint ${endpoint.replace(/:\d+$/, '')}`);
    // Only subscribe to speakers once the connection can actually carry audio.
    if (this.agentEnabled) this.receiver.start();
    return this;
  }

  // --- listening ------------------------------------------------------------

  /**
   * Turn listening on or off at runtime. The deafen flag is part of the join
   * config, so flipping it means re-announcing our voice state — that's what
   * updates the icon everyone else sees.
   */
  async setAgentEnabled(enabled) {
    if (this.destroyed || enabled === this.agentEnabled) return this.agentEnabled;
    this.agentEnabled = enabled;

    try {
      this.connection.rejoin({ selfDeaf: !enabled, selfMute: false });
    } catch (err) {
      console.warn(`[voice:${this.guildId}] could not update deafen state: ${err.message}`);
    }

    if (enabled) {
      await entersState(this.connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
      this.receiver.start();
    } else {
      this.receiver.stop({ clear: true });
      this.eager?.stop();
      this.eager = null;
      this.cancelWake();
    }

    this.emit('update');
    return this.agentEnabled;
  }

  // --- speaking -------------------------------------------------------------

  humansInChannel() {
    const channel = this.client.channels.cache.get(this.channelId);
    if (!channel) return 0;
    return channel.members.filter((m) => !m.user.bot).size;
  }

  /** Whether the agent is mid-sentence — used to avoid talking over itself. */
  get speaking() {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  /** What is on right now, and what is waiting. For the tools and the panel. */
  musicStatus() {
    return {
      current: this.music.current ? { ...this.music.current } : null,
      queue: this.music.queue.map((t) => ({ title: t.title, requestedBy: t.requestedBy })),
      volume: this.music.volume,
      paused: this.music.pausedByUser,
      // Whether the level can actually be applied right now. Without this, a
      // volume change that lands on nothing looks identical to one that works.
      live: Boolean(this.music.resource?.volume),
    };
  }

  /**
   * Begin one continuous spoken answer.
   *
   * Replaces whatever was being said — a second answer starting over the top
   * of the first is worse than a slightly delayed one.
   */
  /**
   * Give the connection to one player, taking it from the other.
   *
   * `subscribe` replaces the previous subscription, so this is the whole
   * mechanism — but the reference is kept so nothing leaks when the session
   * goes.
   */
  #handMouthTo(owner) {
    if (this.destroyed) return;
    this.subscription = this.connection.subscribe(
      owner === 'music' ? this.music.player : this.player,
    );
  }

  startSpeech() {
    this.speech?.cancel();
    this.player.stop(true);

    // Answering a question should not cost you the song. The track pauses
    // rather than stopping, so it picks up where it left off.
    //
    // In music mode neither happens: pausing to make room for a voice that
    // will never arrive is the whole thing the mode exists to prevent, so the
    // song keeps the connection and the queue below is born mute.
    const wasPlaying = this.quiet ? false : this.music.pauseForSpeech();
    if (!this.quiet) this.#handMouthTo('speech');

    const speech = new SpeechQueue(this.player, () => this.quiet);
    this.speech = speech;
    speech.finished
      .catch(() => {})
      .then(() => {
        // Only if this is still the current speech: a second question can
        // start one while the first is draining, and handing music the mouth
        // then would cut the new answer off mid-sentence.
        if (this.destroyed || this.speech !== speech) return;
        // Cleared before the handover: `this.speech` is what tells the music
        // player whether anyone is talking, and a stale one would leave a
        // track that starts later playing to nobody.
        this.speech = null;
        this.#handMouthTo('music');
        if (wasPlaying) this.music.resumeAfterSpeech();
      });
    return speech;
  }

  /**
   * Turn music mode on or off, and report where it landed.
   *
   * Turning it on cancels whatever is being said. Somebody asking for quiet
   * over a song wants the sentence they are hearing to stop, not the one
   * after it — and the cancellation is also what hands the connection back to
   * the music.
   */
  setQuiet(quiet) {
    const wanted = Boolean(quiet);
    if (wanted === this.quiet) return this.quiet;
    this.quiet = wanted;
    if (wanted) this.speech?.cancel();
    this.emit('update');
    return this.quiet;
  }

  /** Cut off playback immediately. Backs a "stop talking" control. */
  shush() {
    // Cancel the queue first: stopping the player alone would just start the
    // next sentence, which is the opposite of being asked to stop. The queue
    // is not cleared here: cancelling settles its `finished`, and that handler
    // is what hands the mouth back to the music and resumes a paused track.
    // Clearing it first made the handler bail, and a shush over a song left
    // the song paused for good.
    this.speech?.cancel();
    this.player.stop(true);
    this.emit('update');
  }

  destroy() {
    this.cancelWake();
    try {
      this.eager?.stop();
    } catch {
      /* never started */
    }
    try {
      this.receiver.stop({ clear: true });
    } catch {
      /* never started */
    }
    try {
      // Leaves two subprocesses per track alive otherwise, for as long as the
      // bot runs.
      this.music.destroy();
    } catch {
      /* never played anything */
    }
    try {
      this.speech?.cancel();
      this.speech = null;
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
      listeners: this.humansInChannel(),
      speaking: this.speaking,
      quiet: this.quiet,
      agentEnabled: this.agentEnabled,
      listening: this.receiver.status(),
      eager: this.eager?.status() ?? null,
      agentNames: config.get('agentNames'),
      wakeEnabled: config.get('wakeEnabled'),
    };
  }
}
