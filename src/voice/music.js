/**
 * Playing music through the bot's own voice connection.
 *
 * This started as a tool that typed `m!p` into a text channel for the music
 * bot that was already there. It cannot work, and the reason is Discord rather
 * than anything we wrote: a bot's message carries `author.bot = true`, and
 * essentially every bot drops those in its first line to avoid loops. Measured
 * both ways — posted as the bot and posted through a webhook, with a command
 * confirmed to work when a person typed it — and neither got a reply.
 *
 * So the bot plays it. That turned out to be the better product anyway: it now
 * knows what is playing, which is the thing a separate music bot could never
 * tell it.
 *
 * The hard part is not fetching audio, it is the mouth. A voice connection
 * carries one player, and the bot already uses it to talk. Mixing music and
 * speech into one stream would mean resampling and summing PCM ourselves; two
 * players and a handover does the same job for the listener — the music pauses
 * while it answers and picks up where it left off, which is what a person
 * would do.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';
import { AudioPlayerStatus, StreamType, createAudioPlayer, createAudioResource } from '@discordjs/voice';

import { commonArgs, ensureYtDlp, resolveTrack } from '../agent/ytdlp.js';
import { normalise } from '../agent/wake.js';

/** Nobody queues more than this on purpose, and an agent in a loop might. */
const MAX_QUEUE = 50;

/**
 * How loud, as a percentage, and how far it may be pushed.
 *
 * Above 100 the samples are amplified rather than attenuated, so the ceiling
 * is where it starts to clip rather than where the number stops being round.
 */
const DEFAULT_VOLUME = 100;
const MAX_VOLUME = 150;

export class MusicPlayer extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.pausedForSpeech = false;
    this.processes = new Set();
    this.ytDlpBin = null;
    // Kept on the player rather than on the track: turning it down once should
    // stay down for whatever plays next, which is what a volume knob does.
    this.volume = DEFAULT_VOLUME;
    this.resource = null;
    // Two different pauses that must not undo each other: one is the bot
    // making room to talk, the other is somebody asking for silence. Resuming
    // after an answer must not restart a track they paused on purpose.
    this.pausedByUser = false;

    this.player = createAudioPlayer();
    this.player.on('error', (err) => console.warn(`[music] ${err.message}`));
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Pausing reports Idle on some transitions; only a real finish advances.
      if (this.pausedForSpeech || this.pausedByUser) return;
      this.#playNext().catch((err) => console.warn(`[music] ${err.message}`));
    });
    // A pause asked for while the next track is still loading is ignored by
    // the player: pause() only acts on Playing, and a track spends its first
    // seconds Buffering behind yt-dlp and ffmpeg. Heard in a call: "pausá" a
    // moment after an album advanced, "paused" written back, the song playing
    // on, and the next "pausá" told it was already paused. So the pause is
    // a fact about this player, kept in the two flags, and enforced again the
    // moment the player starts playing anything.
    this.player.on('stateChange', (_was, now) => {
      if (now.status !== AudioPlayerStatus.Playing) return;
      if (this.pausedByUser || this.pausedForSpeech) this.player.pause(true);
    });
  }

  get playing() {
    return Boolean(this.current);
  }

  /**
   * Set the level, absolutely or by a step, and report where it landed.
   *
   * Relative is the one people actually use — "bajale un poco" — and doing the
   * arithmetic here rather than in the model means it cannot drift: the model
   * would have to be told the current level, remember it, and get the
   * subtraction right, every time.
   */
  setVolume({ level, change } = {}) {
    const from = this.volume;
    const wanted = Number.isFinite(level) ? level : from + (Number(change) || 0);
    this.volume = Math.max(0, Math.min(MAX_VOLUME, Math.round(wanted)));
    const applied = Boolean(this.resource?.volume);
    this.resource?.volume?.setVolume(this.volume / 100);
    console.log(
      `[music] volume ${from}% → ${this.volume}%${applied ? '' : ' (nothing playing to apply it to)'}`,
    );
    return { from, to: this.volume, applied, atLimit: this.volume === 0 || this.volume === MAX_VOLUME };
  }

  /** Look the track up and queue it. Returns what it actually found. */
  async add(query, requestedBy) {
    if (this.queue.length >= MAX_QUEUE) {
      throw new Error('The queue is full.');
    }
    this.ytDlpBin = await ensureYtDlp();
    const track = await resolveTrack(query);
    this.queue.push({ ...track, requestedBy });

    // Nothing playing means this one starts now rather than waiting for an
    // Idle that is never coming.
    const startedNow = !this.current;
    if (startedNow) await this.#playNext();
    return { track, startedNow, position: this.queue.length };
  }

  /**
   * Queue several at once, looking none of them up yet.
   *
   * An album is a dozen tracks, and resolving a dozen searches against YouTube
   * before the first note plays is twenty seconds of nothing. Each one is
   * looked up when its turn comes instead, which costs about a second at a
   * moment when a song is already playing over it.
   */
  async addMany(queries, requestedBy) {
    const room = MAX_QUEUE - this.queue.length - (this.current ? 1 : 0);
    if (room <= 0) throw new Error('The queue is full.');

    const wanted = queries.map((q) => String(q).trim()).filter(Boolean).slice(0, room);
    if (!wanted.length) throw new Error('Nothing to queue.');

    this.ytDlpBin = await ensureYtDlp();
    for (const query of wanted) {
      // No title yet: it is whatever the search turns up when it plays.
      this.queue.push({ query, title: query, requestedBy, unresolved: true });
    }

    const startedNow = !this.current;
    if (startedNow) await this.#playNext();
    return { queued: wanted.length, startedNow, dropped: queries.length - wanted.length };
  }

  /**
   * Take one out of the queue by name or by position.
   *
   * Refuses on an ambiguous name rather than picking: the queue is shared, and
   * removing somebody else's song because it sounded close is worse than
   * asking which one.
   */
  remove(which) {
    const said = String(which ?? '').trim();
    if (!said) throw new Error('Say which one.');

    const asNumber = Number(said);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= this.queue.length) {
      return this.queue.splice(asNumber - 1, 1)[0];
    }

    const needle = normalise(said);
    const hits = this.queue.filter((t) => normalise(t.title).includes(needle));
    if (!hits.length) throw new Error(`Nothing in the queue matches "${said}".`);
    if (hits.length > 1) {
      throw new Error(`"${said}" matches ${hits.length} of them — say which, or its number.`);
    }
    this.queue.splice(this.queue.indexOf(hits[0]), 1);
    return hits[0];
  }

  /** Move one to a position, counting from 1. Same matching as remove. */
  move(which, to) {
    const track = this.remove(which);
    const at = Math.max(0, Math.min(this.queue.length, Math.round(to) - 1));
    this.queue.splice(at, 0, track);
    return { track, position: at + 1 };
  }

  /** Somebody asked for silence, which is not the same as the bot talking. */
  pause() {
    if (!this.current || this.pausedByUser) return false;
    this.pausedByUser = true;
    this.player.pause(true);
    return true;
  }

  resume() {
    if (!this.pausedByUser) return false;
    this.pausedByUser = false;
    // Still mid-answer: let the speech handover bring it back, or it would
    // start playing over the sentence being spoken.
    if (!this.pausedForSpeech) this.player.unpause();
    return true;
  }

  skip() {
    const was = this.current;
    if (!was) return null;
    this.player.stop(true);
    return was;
  }

  stop() {
    this.queue.length = 0;
    this.current = null;
    this.pausedByUser = false;
    this.player.stop(true);
    this.#killProcesses();
  }

  /**
   * Hand the connection back to the speaking voice.
   *
   * Paused rather than stopped: the ffmpeg process stays alive and the track
   * resumes mid-bar, so answering a question does not cost you the song.
   */
  pauseForSpeech() {
    if (!this.current) return false;
    this.pausedForSpeech = true;
    this.player.pause(true);
    return true;
  }

  resumeAfterSpeech() {
    if (!this.pausedForSpeech) return;
    this.pausedForSpeech = false;
    // Paused on purpose before the question was asked: finishing the answer is
    // not a reason to start it again.
    if (!this.pausedByUser) this.player.unpause();
  }

  async #playNext() {
    this.#killProcesses();
    const next = this.queue.shift();
    this.current = next ?? null;
    this.resource = null;
    if (!next) {
      this.emit('update');
      return;
    }

    try {
      // Queued as a bare query — an album track nobody looked up yet. This is
      // where that second is spent, under whatever is already playing.
      if (next.unresolved) {
        Object.assign(next, await resolveTrack(next.query), { unresolved: false });
      }
      this.player.play(this.#resourceFor(next));
      console.log(`[music] playing: ${next.title}`);
    } catch (err) {
      // One track nobody can find should cost that track, not the rest of the
      // album behind it.
      console.warn(`[music] skipping ${next.title}: ${err.message}`);
      await this.#playNext();
      return;
    }
    this.emit('update');
  }

  /**
   * yt-dlp piped into ffmpeg, decoded to what Discord wants.
   *
   * Streamed rather than downloaded: a five-minute track starts playing in
   * about a second this way, and nothing ever lands on disk — the same
   * property the audio buffer has, for the same reason.
   */
  #resourceFor(track) {
    const ytdlp = spawn(
      this.ytDlpBin,
      [...commonArgs(), '-f', 'bestaudio', '-o', '-', track.url],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const ffmpeg = spawn(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    ytdlp.stdout.pipe(ffmpeg.stdin).on('error', () => {});

    this.processes.add(ytdlp).add(ffmpeg);
    // inlineVolume costs a little CPU per packet and is the only way to change
    // the level of something already playing; without it the knob would only
    // take effect on the next track.
    this.resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    this.resource.volume?.setVolume(this.volume / 100);
    return this.resource;
  }

  #killProcesses() {
    for (const proc of this.processes) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    this.processes.clear();
  }

  destroy() {
    this.stop();
    this.player.stop(true);
  }
}
