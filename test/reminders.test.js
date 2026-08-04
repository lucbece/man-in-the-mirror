import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { reminders, MIN_DELAY_MS, MAX_DELAY_MS, MAX_PER_GUILD } from '../src/agent/reminders.js';

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
