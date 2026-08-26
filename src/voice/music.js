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

import { ensureYtDlp, resolveTrack } from '../agent/ytdlp.js';

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

    this.player = createAudioPlayer();
    this.player.on('error', (err) => console.warn(`[music] ${err.message}`));
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Pausing reports Idle on some transitions; only a real finish advances.
      if (this.pausedForSpeech) return;
      this.#playNext();
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
    this.resource?.volume?.setVolume(this.volume / 100);
    return { from, to: this.volume, atLimit: this.volume === 0 || this.volume === MAX_VOLUME };
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
    if (startedNow) this.#playNext();
    return { track, startedNow, position: this.queue.length };
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
    this.player.unpause();
  }

  #playNext() {
    this.#killProcesses();
    const next = this.queue.shift();
    this.current = next ?? null;
    this.resource = null;
    if (!next) {
      this.emit('update');
      return;
    }

    try {
      this.player.play(this.#resourceFor(next));
      console.log(`[music] playing: ${next.title}`);
    } catch (err) {
      console.warn(`[music] could not play ${next.title}: ${err.message}`);
      this.#playNext();
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
      ['--no-warnings', '--no-playlist', '-f', 'bestaudio', '-o', '-', track.url],
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
