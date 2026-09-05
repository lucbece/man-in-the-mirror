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

    const first = await music.add('beat it', 'Vero');
    assert.equal(first.startedNow, true);
    assert.equal(music.playing, true);

    const second = await music.add('thriller', 'Marco');
    assert.equal(second.startedNow, false);
    assert.equal(second.position, 1, 'queued behind the one playing');
  });

  test('skipping reports what it skipped, and nothing when nothing is on', async () => {
    const music = player();
    assert.equal(music.skip(), null, 'nothing playing');

    await music.add('beat it', 'Vero');
    const skipped = music.skip();
    assert.equal(skipped.title, 'Track 1');
  });

  test('stopping clears the queue, unlike skipping', async () => {
    const music = player();
    await music.add('a', 'Vero');
    await music.add('b', 'Vero');
    await music.add('c', 'Vero');
    assert.equal(music.queue.length, 2);

    music.stop();

    assert.equal(music.queue.length, 0);
    assert.equal(music.current, null);
  });

  test('remembers who asked for what, since the room will ask', async () => {
    const music = player();
    await music.add('a', 'Vero');
    await music.add('b', 'Marco');

    assert.equal(music.current.requestedBy, 'Vero');
    assert.equal(music.queue[0].requestedBy, 'Marco');
  });
});

describe('sharing one mouth with the talking voice', () => {
  test('pausing for speech keeps the track, rather than losing it', async () => {
    // Answering a question must not cost you the song: paused, not stopped,
    // so it picks up mid-bar.
    const music = player();
    await music.add('beat it', 'Vero');

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
    await music.add('a', 'Vero');
    await music.add('b', 'Vero');
    music.pauseForSpeech();

    music.player.emit(AudioPlayerStatus.Idle);

    assert.equal(music.current.title, 'Track 1', 'must not have moved on');
    assert.equal(music.queue.length, 1);
  });

  test('a skip while the bot is speaking still advances, and the next track waits for the speech', async () => {
    const music = player();
    await music.add('a', 'Vero');
    await music.add('b', 'Vero');
    music.pauseForSpeech();
    // The fake's stop() moves the player's state, and the real state setter
    // emits Idle for it, exactly as the real player does once.
    const skipped = music.skip();
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    assert.equal(skipped.title, 'Track 1');
    assert.equal(music.current.title, 'Track 2', 'the queue moved on despite the pause');
    assert.equal(music.pausedForSpeech, true, 'and the new track is held until the speech ends');
    music.resumeAfterSpeech();
    assert.equal(music.pausedForSpeech, false);
  });

  test('a skip while paused by the user plays the next one', async () => {
    const music = player();
    await music.add('a', 'Vero');
    await music.add('b', 'Vero');
    music.pause();
    music.skip();
    await new Promise((r) => {
      setTimeout(r, 0);
    });
    assert.equal(music.current.title, 'Track 2');
    assert.equal(music.pausedByUser, false, 'skipping means play the next one');
  });

  test('resuming twice is not an error', async () => {
    const music = player();
    await music.add('a', 'Vero');
    music.pauseForSpeech();
    music.resumeAfterSpeech();
    assert.doesNotThrow(() => music.resumeAfterSpeech());
  });
});

describe('the volume knob', () => {
  test('a nudge is relative, so the model never has to know where it was', () => {
    // "bajale un poco" would otherwise mean telling the model the current
    // level, having it remember, and getting the subtraction right each time.
    const music = new MusicPlayer();
    assert.equal(music.volume, 100);

    // `applied` is false with nothing playing: there is no live resource to
    // put the level on, and the tool says so rather than claiming success.
    assert.deepEqual(music.setVolume({ change: -15 }), { from: 100, to: 85, applied: false, atLimit: false });
    assert.deepEqual(music.setVolume({ change: -15 }), { from: 85, to: 70, applied: false, atLimit: false });
    assert.equal(music.setVolume({ change: 30 }).to, 100);
  });

  test('an absolute level is for when they said a number', () => {
    const music = new MusicPlayer();
    assert.equal(music.setVolume({ level: 30 }).to, 30);
  });

  test('it cannot be turned below silence or past clipping', () => {
    const music = new MusicPlayer();

    assert.deepEqual(music.setVolume({ change: -500 }), { from: 100, to: 0, applied: false, atLimit: true });
    assert.equal(music.setVolume({ change: 5000 }).to, 150);
  });

  test('says when it could not move, so the bot can mention it', () => {
    // The one volume change worth speaking about: the one that did nothing.
    const music = new MusicPlayer();
    music.setVolume({ level: 0 });

    const result = music.setVolume({ change: -15 });
    assert.equal(result.from, result.to);
    assert.equal(result.atLimit, true);
  });

  test('the level outlives the track', async () => {
    // Turning it down once should stay down for whatever plays next, which is
    // what a volume knob does.
    const music = new MusicPlayer();
    music.setVolume({ change: -40 });
    assert.equal(music.volume, 60);

    music.stop();
    assert.equal(music.volume, 60, 'stopping is not resetting');
  });
});

describe('editing the queue', () => {
  /** A player with a queue already in it, and nothing spawning processes. */
  function queued(titles) {
    const music = new MusicPlayer();
    music.player.play = () => {};
    music.player.stop = () => true;
    music.player.pause = () => true;
    music.player.unpause = () => true;
    music.queue = titles.map((title) => ({ title, requestedBy: 'Vero' }));
    return music;
  }

  test('takes one out by part of its title', () => {
    const music = queued(['Californication', 'Otherside', 'Scar Tissue']);

    assert.equal(music.remove('otherside').title, 'Otherside');
    assert.deepEqual(music.queue.map((t) => t.title), ['Californication', 'Scar Tissue']);
  });

  test('or by its number, counting from one', () => {
    const music = queued(['A', 'B', 'C']);
    assert.equal(music.remove('2').title, 'B');
  });

  test('refuses an ambiguous name rather than picking one', () => {
    // The queue is shared. Removing somebody else's song because it sounded
    // close is worse than asking which.
    const music = queued(['Love Song', 'Love Buzz']);

    assert.throws(() => music.remove('love'), /matches 2/);
    assert.equal(music.queue.length, 2, 'and removed nothing');
  });

  test('says so when nothing matches', () => {
    assert.throws(() => queued(['A']).remove('Zeppelin'), /Nothing in the queue matches/);
  });

  test('moves one to a position', () => {
    const music = queued(['A', 'B', 'C']);

    assert.equal(music.move('C', 1).position, 1);
    assert.deepEqual(music.queue.map((t) => t.title), ['C', 'A', 'B']);
  });

  test('a position past the end lands at the end, not out of bounds', () => {
    const music = queued(['A', 'B', 'C']);
    music.move('A', 99);
    assert.deepEqual(music.queue.map((t) => t.title), ['B', 'C', 'A']);
  });
});

describe('two kinds of pause', () => {
  function playing() {
    const music = new MusicPlayer();
    music.player.play = () => {};
    music.player.stop = () => true;
    music.player.pause = () => true;
    music.player.unpause = () => true;
    music.current = { title: 'Californication' };
    return music;
  }

  test('a pause asked for while the track is still loading holds once it plays', async () => {
    // The player ignores pause() unless it is Playing, and the seconds after
    // an album advances are spent Buffering behind yt-dlp. The pause is kept
    // as a fact and applied the moment playback actually starts.
    const music = player();
    await music.add('a', 'Vero');
    // The real setter wants a real resource; the transition is what matters.
    const transition = (status) => {
      const was = music.player.state;
      music.player._state = { status };
      music.player.emit('stateChange', was, music.player.state);
    };
    transition(AudioPlayerStatus.Buffering);
    let pauses = 0;
    music.player.pause = () => {
      pauses += 1;
      return music.player.state.status === AudioPlayerStatus.Playing;
    };
    assert.equal(music.pause(), true);
    assert.equal(pauses, 1, 'tried, and was ignored by a buffering player');
    transition(AudioPlayerStatus.Playing);
    assert.equal(pauses, 2, 'paused again the moment it started playing');
    assert.equal(music.pausedByUser, true);
    assert.equal(music.resume(), true);
  });

  test('the same holds for a pause made for speech', async () => {
    const music = player();
    await music.add('a', 'Vero');
    const transition = (status) => {
      const was = music.player.state;
      music.player._state = { status };
      music.player.emit('stateChange', was, music.player.state);
    };
    transition(AudioPlayerStatus.Buffering);
    let pauses = 0;
    music.player.pause = () => {
      pauses += 1;
      return false;
    };
    music.pauseForSpeech();
    transition(AudioPlayerStatus.Playing);
    assert.equal(pauses, 2);
  });

  test('a track paused on purpose is not resumed by finishing an answer', () => {
    // The bug this prevents: they pause the music, ask something, and the
    // answer ending starts the music again on its own.
    const music = playing();
    music.pause();

    music.pauseForSpeech();
    music.resumeAfterSpeech();

    assert.equal(music.pausedByUser, true, 'still paused, as they left it');
  });

  test('resuming while the bot is talking waits for it to finish', () => {
    // Unpausing here would play over the sentence being spoken.
    const music = playing();
    music.pause();
    music.pauseForSpeech();

    let unpaused = false;
    music.player.unpause = () => { unpaused = true; };
    music.resume();

    assert.equal(unpaused, false);
    assert.equal(music.pausedByUser, false, 'but it is no longer theirs to hold');
  });

  test('reports honestly when there was nothing to do', () => {
    const music = playing();
    assert.equal(music.pause(), true);
    assert.equal(music.pause(), false, 'already paused');
    assert.equal(music.resume(), true);
    assert.equal(music.resume(), false, 'was not paused');
  });

  test('a paused track does not let the queue run on without it', () => {
    const music = playing();
    music.queue = [{ title: 'next' }];
    music.pause();

    music.player.emit('idle');

    assert.equal(music.current.title, 'Californication');
  });
});

describe('an album is its songs', () => {
  /** Something already playing, so queueing does not start a real lookup. */
  function busy() {
    const music = new MusicPlayer();
    music.ytDlpBin = '/bin/true';
    music.current = { title: 'algo que ya suena' };
    return music;
  }

  test('queues the whole track list without looking any of it up first', async () => {
    // Resolving a dozen searches before the first note is twenty seconds of
    // nothing. They are queued unresolved and looked up when their turn comes,
    // under whatever is already playing.
    const music = busy();

    const { queued, startedNow } = await music.addMany(['a', 'b', 'c', 'd'], 'Vero');

    assert.equal(queued, 4);
    assert.equal(startedNow, false);
    assert.deepEqual(music.queue.map((t) => t.unresolved), [true, true, true, true]);
    assert.deepEqual(music.queue.map((t) => t.requestedBy), ['Vero', 'Vero', 'Vero', 'Vero']);
  });

  test('a title stands in until the real one is known', async () => {
    // The queue is readable straight away — now_playing has something to say
    // about what is coming, rather than four blanks.
    const music = busy();
    await music.addMany(['Otherside Red Hot Chili Peppers'], 'Vero');

    assert.match(music.queue[0].title, /Otherside/);
  });

  test('an empty track list is refused rather than queueing nothing', async () => {
    await assert.rejects(() => busy().addMany([], 'Vero'), /Nothing to queue/);
    await assert.rejects(() => busy().addMany(['  ', ''], 'Vero'), /Nothing to queue/);
  });

  test('a long album cannot overrun the queue limit', async () => {
    const music = busy();
    const { queued, dropped } = await music.addMany(
      Array.from({ length: 80 }, (_, i) => `track ${i}`),
      'Vero',
    );

    assert.ok(queued <= 50, `queued ${queued}`);
    assert.ok(dropped > 0, 'and says how many did not fit');
  });
});

describe('a volume change that lands on nothing', () => {
  test('says so, instead of reporting success into silence', () => {
    // This is what made "el bot no responde al comando de bajar el volumen"
    // impossible to diagnose: with nothing playing, the level was stored, the
    // tool reported a number, and not one thing changed that anyone could
    // hear. Identical from the outside to it being broken.
    const music = new MusicPlayer();
    const result = music.setVolume({ change: -15 });

    assert.equal(result.to, 85, 'the level is still remembered for the next track');
    assert.equal(result.applied, false, 'but nothing heard it');
  });
});

describe('the compact status the panel reads', () => {
  test('nothing playing', () => {
    const music = new MusicPlayer();
    assert.deepEqual(music.status(), {
      playing: false,
      paused: false,
      title: null,
      queued: 0,
      volume: 100,
    });
  });

  test('a track playing, one queued behind it, at a changed volume', async () => {
    const music = player();
    await music.add('beat it', 'Vero');
    await music.add('thriller', 'Marco');
    music.setVolume({ level: 60 });

    const status = music.status();
    assert.equal(status.playing, true);
    assert.equal(status.paused, false);
    assert.equal(status.title, music.current.title);
    assert.equal(status.queued, 1);
    assert.equal(status.volume, 60);
  });

  test('paused by the person listening, not by a speech handover', async () => {
    const music = player();
    await music.add('beat it', 'Vero');
    music.pause();

    assert.equal(music.status().playing, true, 'the track is still current, just not moving');
    assert.equal(music.status().paused, true);
  });
});
