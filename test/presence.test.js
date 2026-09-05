import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Presence, rejoinRecent, REJOIN_WITHIN_MS } from '../src/voice/presence.js';

const scratch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'presence-')), 'voice.json');

describe('remembering where the bot was', () => {
  test('a channel joined is remembered; one left on purpose is not', () => {
    const p = new Presence({ file: scratch() });
    p.remember('g1', 'c1');
    p.remember('g2', 'c2');
    assert.deepEqual(p.recent(), [{ guildId: 'g1', channelId: 'c1' }, { guildId: 'g2', channelId: 'c2' }]);
    p.forget('g1');
    assert.deepEqual(p.recent(), [{ guildId: 'g2', channelId: 'c2' }]);
  });

  test('too long ago is not worth returning to', () => {
    let now = 1_000_000;
    const p = new Presence({ file: scratch(), now: () => now });
    p.remember('g1', 'c1');
    now += REJOIN_WITHIN_MS + 1;
    assert.deepEqual(p.recent(), []);
  });

  test('a missing or broken file is an empty memory, not a crash', () => {
    const file = scratch();
    const p = new Presence({ file });
    assert.deepEqual(p.recent(), []);
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(p.recent(), []);
  });
});

describe('coming back after a restart', () => {
  const channel = (name, humans, bots = 1) => ({
    name,
    members: new Map(
      [...Array(humans + bots)].map((_, i) => [`m${i}`, { user: { bot: i >= humans } }]),
    ),
  });

  test('rejoins a channel that still has people, forgets one that is empty or gone', async () => {
    const p = new Presence({ file: scratch() });
    p.remember('g1', 'c1');
    p.remember('g2', 'c2');
    p.remember('g3', 'c3');
    const channels = { c1: channel('general', 2), c2: channel('afk', 0), c3: null };
    const joined = [];
    const log = [];
    const back = await rejoinRecent(p, {
      fetchChannel: async (id) => channels[id],
      join: async (c) => joined.push(c.name),
      log: (l) => log.push(l),
    });
    assert.deepEqual(joined, ['general']);
    assert.deepEqual(back.map((b) => b.channelId), ['c1']);
    assert.deepEqual(p.recent().map((r) => r.guildId), ['g1'], 'only the one it is in stays remembered');
    assert.ok(log.some((l) => /nobody is there/.test(l)) && log.some((l) => /channel is gone/.test(l)));
  });

  test('a join that fails is logged and does not stop the others', async () => {
    const p = new Presence({ file: scratch() });
    p.remember('g1', 'c1');
    p.remember('g2', 'c2');
    const log = [];
    const back = await rejoinRecent(p, {
      fetchChannel: async (id) => channel(id, 1),
      join: async (c) => {
        if (c.name === 'c1') throw new Error('no permission');
      },
      log: (l) => log.push(l),
    });
    assert.deepEqual(back.map((b) => b.channelId), ['c2']);
    assert.ok(log.some((l) => /could not rejoin #c1: no permission/.test(l)));
  });
});
