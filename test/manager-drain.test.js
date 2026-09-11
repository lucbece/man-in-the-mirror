import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';

import { SessionManager } from '../src/voice/manager.js';
import { AgentBusyError } from '../src/agent/index.js';

/**
 * SessionManager.drain() — the drain shutdown runs before leaveAll() tears
 * anything down. See AUDIT.md's "Shutdown cuts the bot off mid-sentence"
 * entry, closed by this file's manager.js changes: without a drain,
 * leaveAll -> session.destroy() cancels speech and stops the player
 * unconditionally, on every deploy that lands mid-answer.
 *
 * A fake askFn cannot drive agent/index.js's own whenIdle(): that function
 * answers out of the real module's `inFlight` set, which a fake bypassing
 * ask() entirely never touches. So the manager's `whenIdle` is injected too
 * (default: the real one), and this file builds a fake pair that tracks
 * exactly the same in-flight state the fake askFn itself has — the same
 * shape as the real ask()/whenIdle() pairing, just scoped to the fake.
 */

/** A session with only the surface drain() and handleWake touch. */
function fakeSession(channel) {
  const session = new EventEmitter();
  Object.assign(session, {
    guildId: channel.guild.id,
    channelId: channel.id,
    channelName: channel.name,
    destroyed: false,
    speech: null,
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
 * A fake askFn paired with a whenIdle() that tracks exactly the same
 * per-guild busy state — one call in flight at a time, exactly like the real
 * ask()/whenIdle() pair sharing agent/index.js's `inFlight` set.
 */
function fakeAskWithIdle() {
  const started = [];
  const busy = new Set();
  const waiters = new Map();

  const settle = (guildId) => {
    const ws = waiters.get(guildId);
    if (!ws) return;
    waiters.delete(guildId);
    for (const resolve of ws) resolve();
  };

  const askFn = (session, payload) => {
    if (busy.has(session.guildId)) {
      return Promise.reject(new AgentBusyError('Still working on the last one.'));
    }
    busy.add(session.guildId);
    return new Promise((resolve, reject) => {
      started.push({
        payload,
        resolve: (value) => {
          busy.delete(session.guildId);
          settle(session.guildId);
          resolve(value);
        },
        reject: (err) => {
          busy.delete(session.guildId);
          settle(session.guildId);
          reject(err);
        },
      });
    });
  };

  const whenIdle = (guildId) => {
    if (!busy.has(guildId)) return Promise.resolve();
    return new Promise((resolve) => {
      const ws = waiters.get(guildId) ?? [];
      ws.push(resolve);
      waiters.set(guildId, ws);
    });
  };

  askFn.started = started;
  return { askFn, whenIdle };
}

/** Two event-loop turns: the same margin manager-held-wake.test.js uses. */
const flush = async () => {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
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

function manager(t, { askFn, whenIdle } = {}) {
  const m = new SessionManager({ createSession: fakeSession, warmAgent: () => {}, askFn, whenIdle });
  t.after(() => m.dispose());
  return m;
}

describe('SessionManager.drain()', () => {
  test('waits for the in-flight ask to settle and the speech queue to drain', async (t) => {
    const { askFn, whenIdle } = fakeAskWithIdle();
    const m = manager(t, { askFn, whenIdle });
    const session = await m.join(channel('general'));

    session.emit('wake', wake({ askedBy: 'Vero', heard: 'una pregunta larga' }));
    await flush();
    assert.equal(askFn.started.length, 1, 'the wake reaches ask()');

    // A speech queue in progress, independent of ask()'s own bookkeeping —
    // this is the path a reminder or a late zomboid answer takes, and
    // drain() has to wait on it too, not only on whenIdle().
    let resolveDrained;
    session.speech = { drained: () => new Promise((resolve) => { resolveDrained = resolve; }) };

    let drained = false;
    const drainDone = m.drain({ timeoutMs: 2000 }).then(() => {
      drained = true;
    });

    await flush();
    assert.equal(drained, false, 'must not resolve before the ask settles');

    askFn.started[0].resolve({ spoken: 'listo' });
    await flush();
    assert.equal(drained, false, 'the ask settled, but the speech queue has not drained yet');

    resolveDrained();
    await drainDone;
    assert.equal(drained, true);
  });

  test('gives up at the timeout rather than waiting forever on a wedged session', async (t) => {
    const { askFn, whenIdle } = fakeAskWithIdle();
    const m = manager(t, { askFn, whenIdle });
    const session = await m.join(channel('general'));

    session.emit('wake', wake({ askedBy: 'Vero', heard: 'algo que nunca termina' }));
    await flush();
    assert.equal(askFn.started.length, 1);
    // Never resolved: stands in for a wedged ask().

    const lines = await logsOf(async () => {
      await m.drain({ timeoutMs: 30 });
    });

    assert.ok(
      lines.some((l) => l.startsWith('[shutdown] drain timed out after 30ms')),
      'logs that it gave up, and how long it waited',
    );
  });

  test('refuses a new wake once draining has started', async (t) => {
    const { askFn, whenIdle } = fakeAskWithIdle();
    const m = manager(t, { askFn, whenIdle });
    const session = await m.join(channel('general'));

    const drainDone = m.drain({ timeoutMs: 1000 });

    const lines = await logsOf(async () => {
      session.emit('wake', wake({ askedBy: 'Vero', heard: 'hola' }));
      await flush();
    });

    assert.equal(askFn.started.length, 0, 'never reaches ask() once shutting down');
    assert.ok(lines.some((l) => l === '[wake] Vero: "hola" — ignored, shutting down'));

    await drainDone;
  });

  test('a wake already held when the drain starts is dropped, not replayed', async (t) => {
    const { askFn, whenIdle } = fakeAskWithIdle();
    const m = manager(t, { askFn, whenIdle });
    const session = await m.join(channel('general'));

    session.emit('wake', wake({ askedBy: 'Vero', heard: 'primera' }));
    await flush();
    session.emit('wake', wake({ askedBy: 'Fede', heard: 'segunda' }));
    await flush();
    assert.equal(askFn.started.length, 1, 'Fede is held, not asked yet');

    const drainDone = m.drain({ timeoutMs: 1000 });

    const lines = await logsOf(async () => {
      askFn.started[0].resolve({ spoken: 'primera respuesta' });
      await flush();
    });

    assert.equal(askFn.started.length, 1, 'the held question is never actually asked');
    assert.ok(lines.some((l) => l === '[wake] Fede: "segunda" — ignored, shutting down'));

    await drainDone;
  });
});
