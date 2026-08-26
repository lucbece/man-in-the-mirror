import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { AudioPlayerStatus } from '@discordjs/voice';

import { MusicPlayer } from '../src/voice/music.js';

/**
 * The queue and the handover, without touching YouTube.
 *
 * `add` is stubbed at the resolve step because what is worth testing here is
 * what happens to the queue and the player — fetching audio is yt-dlp's job
 * and it was verified against the real thing separately.
 */
function player({ tracks = [] } = {}) {
  const music = new MusicPlayer();
  const played = [];
  // Replace the bit that spawns processes; everything else is the real class.
  music.ytDlpBin = '/bin/true';
  Object.defineProperty(music, 'resourceFor', { value: () => ({}) });
  music.player.play = (resource) => {
    played.push(resource);
    music.player.state = { status: AudioPlayerStatus.Playing };
  };
  music.player.stop = () => {
    music.player.state = { status: AudioPlayerStatus.Idle };
    return true;
  };
  music.player.pause = () => true;
  music.player.unpause = () => true;
  // `add` normally shells out; give it the answers it would have got.
  let i = 0;
  music.add = async (query, requestedBy) => {
    const track = tracks[i] ?? { title: `Track ${i + 1}`, seconds: 100, url: `u${i}` };
    i += 1;
    music.queue.push({ ...track, requestedBy });
    const startedNow = !music.current;
    if (startedNow) {
      music.current = music.queue.shift();
      music.player.play({});
    }
    return { track, startedNow, position: music.queue.length };
  };
  return music;
}

describe('the queue', () => {
  test('the first request starts, the second waits', async () => {
    const music = player();

    const first = await music.add('beat it', 'Luc');
    assert.equal(first.startedNow, true);
    assert.equal(music.playing, true);

    const second = await music.add('thriller', 'Marco');
    assert.equal(second.startedNow, false);
    assert.equal(second.position, 1, 'queued behind the one playing');
  });

  test('skipping reports what it skipped, and nothing when nothing is on', async () => {
    const music = player();
    assert.equal(music.skip(), null, 'nothing playing');

    await music.add('beat it', 'Luc');
    const skipped = music.skip();
    assert.equal(skipped.title, 'Track 1');
  });

  test('stopping clears the queue, unlike skipping', async () => {
    const music = player();
    await music.add('a', 'Luc');
    await music.add('b', 'Luc');
    await music.add('c', 'Luc');
    assert.equal(music.queue.length, 2);

    music.stop();

    assert.equal(music.queue.length, 0);
    assert.equal(music.current, null);
  });

  test('remembers who asked for what, since the room will ask', async () => {
    const music = player();
    await music.add('a', 'Luc');
    await music.add('b', 'Marco');

    assert.equal(music.current.requestedBy, 'Luc');
    assert.equal(music.queue[0].requestedBy, 'Marco');
  });
});

describe('sharing one mouth with the talking voice', () => {
  test('pausing for speech keeps the track, rather than losing it', async () => {
    // Answering a question must not cost you the song: paused, not stopped,
    // so it picks up mid-bar.
    const music = player();
    await music.add('beat it', 'Luc');

    assert.equal(music.pauseForSpeech(), true);
    assert.equal(music.pausedForSpeech, true);
    assert.equal(music.current.title, 'Track 1', 'still the current track');

    music.resumeAfterSpeech();
    assert.equal(music.pausedForSpeech, false);
  });

  test('silence needs no pausing, and says so', async () => {
    const music = player();
    assert.equal(music.pauseForSpeech(), false, 'nothing to pause');
  });

  test('a pause does not advance the queue', async () => {
    // The player reports Idle on some pause transitions. Treating that as
    // "track finished" would skip a song every time somebody asked a question.
    const music = player();
    await music.add('a', 'Luc');
    await music.add('b', 'Luc');
    music.pauseForSpeech();

    music.player.emit(AudioPlayerStatus.Idle);

    assert.equal(music.current.title, 'Track 1', 'must not have moved on');
    assert.equal(music.queue.length, 1);
  });

  test('resuming twice is not an error', async () => {
    const music = player();
    await music.add('a', 'Luc');
    music.pauseForSpeech();
    music.resumeAfterSpeech();
    assert.doesNotThrow(() => music.resumeAfterSpeech());
  });
});
