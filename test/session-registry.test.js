import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';

/**
 * The 'destroyed' handler from voice/manager.js, in isolation.
 *
 * Reproducing the real race needs a Discord connection, so this exercises the
 * ordering rule the handler encodes: act only when the session firing the
 * event is still the registered one. The bug was that the session map was
 * guarded and the agent session was not, one line below it.
 */
function attachDestroyHandler(sessions, guildId, session, endAgentSession) {
  session.on('destroyed', () => {
    if (sessions.get(guildId) !== session) return;
    sessions.delete(guildId);
    endAgentSession(guildId);
  });
}

const fakeSession = () => new EventEmitter();

describe('a late destroyed event', () => {
  test('a session that is still registered cleans itself up', () => {
    const sessions = new Map();
    const ended = [];
    const session = fakeSession();
    sessions.set('g1', session);
    attachDestroyHandler(sessions, 'g1', session, (id) => ended.push(id));

    session.emit('destroyed');
    assert.equal(sessions.has('g1'), false);
    assert.deepEqual(ended, ['g1']);
  });

  test('a replaced session does not end the new one\'s agent', () => {
    // 'destroyed' arrives from the voice connection's state handler, so it is
    // late. Moving between channels destroys A, registers B, pre-warms B's
    // agent — and only then does A's event arrive. Ending the agent
    // unconditionally there killed the session just prepared for B.
    const sessions = new Map();
    const ended = [];
    const sessionA = fakeSession();
    const sessionB = fakeSession();

    sessions.set('g1', sessionA);
    attachDestroyHandler(sessions, 'g1', sessionA, (id) => ended.push(id));

    // Moved to another channel: B replaces A in the registry.
    sessions.set('g1', sessionB);
    attachDestroyHandler(sessions, 'g1', sessionB, (id) => ended.push(id));

    sessionA.emit('destroyed'); // arrives now

    assert.equal(sessions.get('g1'), sessionB, 'B must stay registered');
    assert.deepEqual(ended, [], "B's agent session must survive");
  });

  test('B still cleans up when it is the one destroyed', () => {
    const sessions = new Map();
    const ended = [];
    const sessionA = fakeSession();
    const sessionB = fakeSession();

    sessions.set('g1', sessionA);
    attachDestroyHandler(sessions, 'g1', sessionA, (id) => ended.push(id));
    sessions.set('g1', sessionB);
    attachDestroyHandler(sessions, 'g1', sessionB, (id) => ended.push(id));

    sessionA.emit('destroyed');
    sessionB.emit('destroyed');

    assert.equal(sessions.has('g1'), false);
    assert.deepEqual(ended, ['g1'], 'exactly once, for B');
  });
});
