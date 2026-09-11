import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { SessionManager, HELD_WAKE_MAX_AGE_MS } from '../src/voice/manager.js';
import { AgentBusyError } from '../src/agent/index.js';

/**
 * The held-wake path, without a gateway or a real ask().
 *
 * Measured over five days of production logs (2026-09-06..10), a second wake
 * while an answer was still playing was dropped 54 times — a real question
 * ("¿podemos hablar en inglés de ahora en más, por favor?") thrown away
 * because ask() allows one request in flight per guild. These prove the
 * replacement: the latest one is held instead, and gets answered once the
 * first settles — unless it's gone stale, or the session ends first.
 */

/** A session with only the surface handleWake touches. */
function fakeSession(channel) {
  const session = new EventEmitter();
  Object.assign(session, {
    guildId: channel.guild.id,
    channelId: channel.id,
    channelName: channel.name,
    destroyed: false,
    expectReply: () => false,
    destroy() {
      session.destroyed = true;
      session.emit('destroyed');
    },
    waitUntilReady: () => Promise.resolve(),
    status: () => ({ guildId: session.guildId, channelId: session.channelId }),
  });
  return session;
}

const channel = (id, { guildId = 'g1' } = {}) => ({ id, name: id, guild: { id: guildId } });

/** One wake payload, in the shape VoiceSession emits it. */
const wake = ({ askedBy, heard, askedById = askedBy }) => ({
  question: heard,
  askedBy,
  askedById,
  heard,
  stoppedAt: Date.now(),
  marks: {},
  viaFollowUp: false,
});

/**
 * A fake ask(): one call in flight at a time, exactly like the real one's
 * `inFlight` set — a call made while another is unsettled is rejected with
 * AgentBusyError straight away rather than actually starting, and the slot
 * frees the moment the one running is resolved or rejected. `started` holds
 * only the calls that got the slot, each left pending until the test settles
 * it, so the test controls exactly when "the current ask() settles".
 */
function fakeAsk() {
  const started = [];
  let busy = false;
  const fn = (session, payload) => {
    if (busy) {
      return Promise.reject(new AgentBusyError('Still working on the last one.'));
    }
    busy = true;
    return new Promise((resolve, reject) => {
      started.push({
        payload,
        resolve: (value) => { busy = false; resolve(value); },
        reject: (err) => { busy = false; reject(err); },
      });
    });
  };
  fn.started = started;
  return fn;
}

/** Two event-loop turns: enough for a resolved promise's continuation to run
 * to its own next await, the same margin the reminder tests in
 * manager.test.js use. */
const flush = async () => {
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
};

/** Captures console.log/warn lines for the duration of `fn`. */
async function logsOf(fn) {
  const lines = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

function manager(t, { askFn = fakeAsk(), heldWakeMaxAgeMs = HELD_WAKE_MAX_AGE_MS } = {}) {
  const m = new SessionManager({
    createSession: fakeSession,
    warmAgent: () => {},
    askFn,
    heldWakeMaxAgeMs,
  });
  t.after(() => m.dispose());
  return m;
}

describe('a wake heard while ask() is still working', () => {
  test('is held, then answered once the in-flight ask() settles', async (t) => {
    const askFn = fakeAsk();
    const m = manager(t, { askFn });
    const session = await m.join(channel('general'));

    const lines = await logsOf(async () => {
      session.emit('wake', wake({ askedBy: 'Vero', heard: 'primera pregunta' }));
      await flush();
      assert.equal(askFn.started.length, 1, 'the first question reaches ask()');

      session.emit('wake', wake({ askedBy: 'Fede', heard: 'segunda pregunta' }));
      await flush();
      // Busy, so it does not start a second ask() — it is held instead.
      assert.equal(askFn.started.length, 1, 'the second one does not start its own ask()');

      askFn.started[0].resolve({ spoken: 'primera respuesta' });
      await flush();
    });

    assert.equal(askFn.started.length, 2, 'the held question got its turn once the first settled');
    assert.equal(askFn.started[1].payload.askedBy, 'Fede');
    assert.equal(askFn.started[1].payload.question, 'segunda pregunta');

    assert.ok(
      lines.some((l) => l === '[wake] Fede asked while it was still answering — held: "segunda pregunta"'),
      'holds rather than drops the second question',
    );
    assert.ok(
      lines.some((l) => l === "[wake] answering Fede's held question"),
      'announces the replay',
    );
  });

  test('a third wake replaces the second, held one, which is logged as dropped', async (t) => {
    const askFn = fakeAsk();
    const m = manager(t, { askFn });
    const session = await m.join(channel('general'));

    const lines = await logsOf(async () => {
      session.emit('wake', wake({ askedBy: 'Vero', heard: 'primera pregunta' }));
      await flush();

      session.emit('wake', wake({ askedBy: 'Fede', heard: 'segunda pregunta' }));
      await flush();
      session.emit('wake', wake({ askedBy: 'Pato', heard: 'tercera pregunta' }));
      await flush();

      askFn.started[0].resolve({ spoken: 'primera respuesta' });
      await flush();
    });

    // Only one slot: Fede's question never got its own ask() call — it was
    // replaced before the first one ever settled.
    assert.equal(askFn.started.length, 2, 'the first ask(), and the held one that survived');
    assert.equal(askFn.started[1].payload.askedBy, 'Pato', 'the latest held wake wins, not the first');

    assert.ok(
      lines.some((l) => l === '[wake] Fede asked while it was still answering — dropped: "segunda pregunta"'),
      'the one it replaced is logged as dropped, not silently forgotten',
    );
    assert.ok(
      lines.some((l) => l === '[wake] Pato asked while it was still answering — held: "tercera pregunta"'),
    );
  });

  test('a held wake older than the max age is dropped, not answered late', async (t) => {
    const askFn = fakeAsk();
    // Real production value is fifteen seconds; a test has no business
    // waiting that long to prove the same branch, so this constructs the
    // manager with a much smaller one — the same injection knob production
    // leaves at HELD_WAKE_MAX_AGE_MS.
    const m = manager(t, { askFn, heldWakeMaxAgeMs: 10 });
    const session = await m.join(channel('general'));

    const lines = await logsOf(async () => {
      session.emit('wake', wake({ askedBy: 'Vero', heard: 'primera pregunta' }));
      await flush();
      session.emit('wake', wake({ askedBy: 'Fede', heard: 'segunda pregunta' }));
      await flush();

      // Outlive the (shrunk) max age before the first ask() finally settles.
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      askFn.started[0].resolve({ spoken: 'primera respuesta' });
      await flush();
    });

    assert.equal(askFn.started.length, 1, 'the stale held question is never replayed');
    assert.ok(
      lines.some((l) => l === "[wake] dropped Fede's held question, too old"),
    );
  });

  test('a held wake is forgotten when the session ends', async (t) => {
    const askFn = fakeAsk();
    const m = manager(t, { askFn });
    const session = await m.join(channel('general'));

    session.emit('wake', wake({ askedBy: 'Vero', heard: 'primera pregunta' }));
    await flush();
    session.emit('wake', wake({ askedBy: 'Fede', heard: 'segunda pregunta' }));
    await flush();
    assert.equal(askFn.started.length, 1, 'Fede is held, not asked yet');

    session.destroy();
    await flush();

    askFn.started[0].resolve({ spoken: 'primera respuesta' });
    await flush();

    assert.equal(askFn.started.length, 1, 'nothing answers on behalf of a channel the bot already left');
  });
});
