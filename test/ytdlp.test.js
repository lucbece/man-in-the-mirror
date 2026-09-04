import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import { blockedByYouTube, commonArgs, resolveTrack } from '../src/agent/ytdlp.js';

const BLOCKED =
  'ERROR: [youtube] Zi_XLOBDo_Y: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.';

/** A yt-dlp that answers by target, and remembers what it was asked. */
function fakeExec(answers) {
  const calls = [];
  const exec = async (_bin, args) => {
    const target = args.at(-1);
    calls.push(args);
    const answer = answers[target] ?? answers[target.split(':')[0]];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error('Nothing found for that.');
    return { stdout: `${answer.title}\n${answer.seconds}\n${answer.url}\n` };
  };
  return { exec, calls };
}

const none = path.join(os.tmpdir(), 'no-cookies-here.txt');

describe('resolving a query', () => {
  test('a search goes to YouTube and reports it', async () => {
    const { exec, calls } = fakeExec({ ytsearch1: { title: 'Beat It', seconds: 258, url: 'https://youtu.be/x' } });
    const track = await resolveTrack('beat it', { exec, binary: 'yt-dlp', cookiesPath: none });
    assert.equal(track.source, 'youtube');
    assert.equal(track.title, 'Beat It');
    assert.equal(calls.length, 1);
  });

  test('when YouTube refuses the address, the same search goes to SoundCloud', async () => {
    // The sentence YouTube answers a datacenter with, verbatim.
    const { exec, calls } = fakeExec({
      ytsearch1: new Error(BLOCKED),
      scsearch1: { title: 'Beat It', seconds: 258, url: 'https://soundcloud.com/x' },
    });
    const track = await resolveTrack('beat it', { exec, binary: 'yt-dlp', cookiesPath: none });
    assert.equal(track.source, 'soundcloud');
    assert.equal(track.url, 'https://soundcloud.com/x');
    assert.deepEqual(calls.map((a) => a.at(-1)), ['ytsearch1:beat it', 'scsearch1:beat it']);
  });

  test('a song nobody has is not retried anywhere', async () => {
    const { exec, calls } = fakeExec({ ytsearch1: new Error('Nothing found for that.') });
    await assert.rejects(() => resolveTrack('zzz', { exec, binary: 'yt-dlp', cookiesPath: none }), /Nothing found/);
    assert.equal(calls.length, 1);
  });

  test('a URL is what they named: refused means refused, with the fix in the message', async () => {
    const { exec, calls } = fakeExec({ 'https://www.youtube.com/watch?v=a': new Error(BLOCKED) });
    await assert.rejects(
      () => resolveTrack('https://www.youtube.com/watch?v=a', { exec, binary: 'yt-dlp', cookiesPath: none }),
      /cookies file/,
    );
    assert.equal(calls.length, 1);
  });

  test('knows the refusal from a miss', () => {
    assert.equal(blockedByYouTube(BLOCKED), true);
    assert.equal(blockedByYouTube('ERROR: no video results'), false);
  });
});

describe('cookies', () => {
  test('are passed only when the file exists', () => {
    assert.deepEqual(commonArgs({ cookiesPath: none }), ['--no-warnings', '--no-playlist']);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mitm-cookies-')), 'youtube-cookies.txt');
    fs.writeFileSync(file, '# Netscape HTTP Cookie File\n');
    assert.deepEqual(commonArgs({ cookiesPath: file }), ['--no-warnings', '--no-playlist', '--cookies', file]);
  });
});
