import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  Reminders,
  reminders,
  MIN_DELAY_MS,
  MAX_DELAY_MS,
  MAX_PER_GUILD,
} from '../src/agent/reminders.js';

// Real timers with tiny delays would make MIN_DELAY_MS untestable, so tests
// that need to *fire* monkey-patch the minimum through the public bounds…
// they can't. Instead: fire-path tests use the real minimum with setTimeout
// mocked per-test via node:test's timer mocking.

describe('reminders registry', () => {
  test('fires once, with the message, and forgets itself', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired = [];
    const onFire = (e) => fired.push(e);
    reminders.on('fire', onFire);
    t.after(() => reminders.off('fire', onFire));
    t.after(() => reminders.clearGuild('g1'));

    const { id } = reminders.set({ guildId: 'g1', delayMs: 10 * 60_000, message: 'sacá la basura' });
    assert.equal(reminders.list('g1').length, 1);

    t.mock.timers.tick(10 * 60_000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].id, id);
    assert.equal(fired[0].message, 'sacá la basura');
    assert.equal(reminders.list('g1').length, 0, 'fired reminders must not linger');
  });

  test('cancel prevents the firing', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired = [];
    const onFire = (e) => fired.push(e);
    reminders.on('fire', onFire);
    t.after(() => reminders.off('fire', onFire));
    t.after(() => reminders.clearGuild('g2'));

    const { id } = reminders.set({ guildId: 'g2', delayMs: 60_000, message: 'x' });
    assert.equal(reminders.cancel('g2', id), true);
    assert.equal(reminders.cancel('g2', id), false, 'second cancel finds nothing');
    t.mock.timers.tick(120_000);
    assert.equal(fired.length, 0);
  });

  test('list reports remaining time, soonest first', (t) => {
    t.after(() => reminders.clearGuild('g3'));
    reminders.set({ guildId: 'g3', delayMs: 20 * 60_000, message: 'later' });
    reminders.set({ guildId: 'g3', delayMs: 10 * 60_000, message: 'sooner' });

    // `now` has to be read after setting, not before: the clock moves between
    // the two, and reading it first made remainingMs come out a few
    // milliseconds over the requested delay whenever the suite ran under load.
    const listed = reminders.list('g3', Date.now());
    assert.deepEqual(
      listed.map((r) => r.message),
      ['sooner', 'later'],
    );
    assert.ok(listed[0].remainingMs <= 10 * 60_000);
    assert.ok(listed[0].remainingMs > 9 * 60_000, 'should be counting down from ten minutes');
    assert.ok(listed[1].remainingMs > 10 * 60_000);
  });

  test('guilds are isolated from each other', (t) => {
    t.after(() => {
      reminders.clearGuild('g4');
      reminders.clearGuild('g5');
    });
    reminders.set({ guildId: 'g4', delayMs: 60_000, message: 'mine' });
    assert.equal(reminders.list('g5').length, 0);
  });

  test('rejects the unreasonable with speakable messages', (t) => {
    t.after(() => reminders.clearGuild('g6'));
    // Too soon, too far, empty — each error is text the agent can relay aloud.
    assert.throws(
      () => reminders.set({ guildId: 'g6', delayMs: MIN_DELAY_MS - 1, message: 'x' }),
      /too soon/,
    );
    assert.throws(
      () => reminders.set({ guildId: 'g6', delayMs: MAX_DELAY_MS + 1, message: 'x' }),
      /twenty-four hours/,
    );
    assert.throws(() => reminders.set({ guildId: 'g6', delayMs: NaN, message: 'x' }), /too soon/);
    assert.throws(() => reminders.set({ guildId: 'g6', delayMs: 60_000, message: '  ' }), /needs a message/);
  });

  test('caps runaway agents at the per-guild limit', (t) => {
    t.after(() => reminders.clearGuild('g7'));
    for (let i = 0; i < MAX_PER_GUILD; i++) {
      reminders.set({ guildId: 'g7', delayMs: 60_000, message: `r${i}` });
    }
    assert.throws(
      () => reminders.set({ guildId: 'g7', delayMs: 60_000, message: 'one too many' }),
      /Too many/,
    );
  });
});

describe('surviving a restart', () => {
  /** A registry with its own file, so these never touch data/reminders.json. */
  function isolated() {
    const file = path.join(os.tmpdir(), `reminders-${process.pid}-${count++}.json`);
    return { file, registry: new Reminders({ file }) };
  }
  let count = 0;

  test('a pending reminder is re-armed by a new process', (t) => {
    // The promise this closes: "recordame a las seis" survived only until
    // something restarted the bot, and nothing ever said otherwise.
    const { file, registry } = isolated();
    t.after(() => fs.rmSync(file, { force: true }));

    registry.set({ guildId: 'g', delayMs: 60 * 60_000, message: 'la reunión' });

    const next = new Reminders({ file });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fired = [];
    next.on('fire', (e) => fired.push(e));

    assert.deepEqual(next.restore(), { restored: 1, missed: 0 });
    assert.equal(next.list('g').length, 1);
    assert.equal(next.list('g')[0].message, 'la reunión');

    t.mock.timers.tick(60 * 60_000);
    assert.equal(fired.length, 1, 'and it still fires');
  });

  test('one that came due while the bot was down is dropped, not said late', (t) => {
    // Saying it hours afterwards, to whoever happens to be in the channel now,
    // is worse than not saying it.
    const { file, registry } = isolated();
    t.after(() => fs.rmSync(file, { force: true }));

    registry.set({ guildId: 'g', delayMs: 10 * 60_000, message: 'sacá la basura' });

    const next = new Reminders({ file });
    assert.deepEqual(next.restore(Date.now() + 60 * 60_000), { restored: 0, missed: 1 });
    assert.equal(next.list('g').length, 0);
  });

  test('cancelling really removes it, restart or not', (t) => {
    const { file, registry } = isolated();
    t.after(() => fs.rmSync(file, { force: true }));

    const { id } = registry.set({ guildId: 'g', delayMs: 60 * 60_000, message: 'x' });
    registry.cancel('g', id);

    assert.deepEqual(new Reminders({ file }).restore(), { restored: 0, missed: 0 });
  });

  test('no file, or a corrupt one, is not a crash on boot', (t) => {
    const { file, registry } = isolated();
    t.after(() => fs.rmSync(file, { force: true }));

    assert.deepEqual(registry.restore(), { restored: 0, missed: 0 }, 'missing file');

    fs.writeFileSync(file, 'not json at all');
    assert.deepEqual(new Reminders({ file }).restore(), { restored: 0, missed: 0 });

    fs.writeFileSync(file, '{"not":"an array"}');
    assert.deepEqual(new Reminders({ file }).restore(), { restored: 0, missed: 0 });
  });

  test('ids do not collide with the ones already restored', (t) => {
    const { file, registry } = isolated();
    t.after(() => fs.rmSync(file, { force: true }));

    registry.set({ guildId: 'g', delayMs: 60 * 60_000, message: 'first' });
    registry.set({ guildId: 'g', delayMs: 60 * 60_000, message: 'second' });

    const next = new Reminders({ file });
    next.restore();
    const { id } = next.set({ guildId: 'g', delayMs: 60 * 60_000, message: 'third' });

    const ids = next.list('g').map((r) => r.id);
    assert.equal(new Set(ids).size, 3, `ids collided: ${ids}`);
    assert.ok(id > 2, 'a new id must not reuse a restored one');
  });
});
