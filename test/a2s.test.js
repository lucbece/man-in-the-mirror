import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import { A2sError, NoAnswer, challengeIn, gameVersion, parseInfo, query } from '../src/agent/a2s.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** A real Build 42 answer, captured from the server the room plays on. */
const REAL = fs.readFileSync(path.join(here, 'fixtures/a2s_info.bin'));

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const challenge = (bytes = [1, 2, 3, 4]) =>
  Buffer.concat([HEADER, Buffer.from('A'), Buffer.from(bytes)]);

describe('reading what the game says about itself', () => {
  test('parses a real Build 42 response', () => {
    const info = parseInfo(REAL);
    assert.equal(info.name, 'PandaParkour');
    assert.equal(info.map, 'Muldraugh, KY');
    assert.equal(info.game, 'Project Zomboid');
    assert.equal(info.players, 1);
    assert.equal(info.maxPlayers, 16);
    assert.equal(info.port, 16261);
    assert.equal(info.locked, true, 'the server has a password');
  });

  test('the version is the one people say out loud, not the protocol field', () => {
    // Project Zomboid puts "1.0.0.0" in the protocol's version field forever;
    // the build is a keyword in the tags.
    assert.equal(parseInfo(REAL).version, '42.20');
    assert.equal(gameVersion('1.0.0.0', ';modded;pvp;VERSION:42.20'), '42.20');
    assert.equal(gameVersion('1.0.0.0', ';modded'), '1.0.0.0', 'no keyword: the field stands');
  });

  test('refuses anything that is not a simple packet', () => {
    assert.throws(() => parseInfo(Buffer.from('not a packet')), A2sError);
    assert.throws(() => parseInfo(challenge()), /wanted 'I'/);
    assert.throws(() => parseInfo(REAL.subarray(0, 12)), A2sError, 'truncated');
  });

  test('a challenge is recognised, an answer is not', () => {
    assert.deepEqual([...challengeIn(challenge([9, 8, 7, 6]))], [9, 8, 7, 6]);
    assert.equal(challengeIn(REAL), null);
    assert.equal(challengeIn(Buffer.alloc(4)), null);
  });
});

describe('the query, without a socket', () => {
  test('answers the challenge and returns what came back', async () => {
    const sent = [];
    const info = await query({
      host: 'game',
      send: async (payload) => {
        sent.push(payload);
        return sent.length === 1 ? challenge([7, 7, 7, 7]) : REAL;
      },
    });
    assert.equal(info.name, 'PandaParkour');
    assert.equal(sent.length, 2, 'the request, then the request with the challenge');
    assert.deepEqual([...sent[1].subarray(-4)], [7, 7, 7, 7], 'the same four bytes come back');
    assert.ok(sent[1].length === sent[0].length + 4);
  });

  test('a server that answers straight away needs no second trip', async () => {
    let calls = 0;
    const info = await query({
      host: 'game',
      send: async () => {
        calls += 1;
        return REAL;
      },
    });
    assert.equal(calls, 1);
    assert.equal(info.players, 1);
  });

  test('silence is retried, and then reported as silence', async () => {
    let calls = 0;
    await assert.rejects(
      query({
        host: 'game',
        attempts: 3,
        send: async () => {
          calls += 1;
          throw new NoAnswer('nothing');
        },
      }),
      NoAnswer,
    );
    assert.equal(calls, 3);
  });

  test('one lost datagram does not cost the answer', async () => {
    let calls = 0;
    const info = await query({
      host: 'game',
      send: async () => {
        calls += 1;
        if (calls === 1) throw new NoAnswer('lost');
        return REAL;
      },
    });
    assert.equal(info.name, 'PandaParkour');
  });

  test('a challenge answered with another challenge is a lost datagram, not an answer', async () => {
    let calls = 0;
    const info = await query({
      host: 'game',
      send: async () => {
        calls += 1;
        // First attempt: challenge, then challenge again. Second: the answer.
        if (calls <= 2) return challenge();
        return REAL;
      },
    });
    assert.equal(info.name, 'PandaParkour');
    assert.equal(calls, 3);
  });

  test('a malformed answer is not retried — the server is up and we are wrong', async () => {
    let calls = 0;
    await assert.rejects(
      query({
        host: 'game',
        send: async () => {
          calls += 1;
          return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('X')]);
        },
      }),
      A2sError,
    );
    assert.equal(calls, 1);
  });

  test('no host is a programming error, not silence', async () => {
    await assert.rejects(query({}), A2sError);
  });
});
