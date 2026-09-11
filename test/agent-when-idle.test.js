import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ask, whenIdle } from '../src/agent/index.js';

/**
 * whenIdle() on its own — see SessionManager.drain(), which waits on it to
 * know whether a guild's ask(), if it has one running, is done.
 *
 * Drives a real ask() with fake collaborators, the same approach as
 * ask.test.js, but with a brain that does not resolve until told to —
 * otherwise there is no way to observe whenIdle() resolving *after* the
 * guild goes idle rather than trivially before ask() ever started.
 */
function deps(release) {
  return {
    toAudioResource: (audio) => audio,
    noteInMusicChannel: async () => true,
    transcribeBuffer: async () => ({ transcribed: 0 }),
    formatTranscript: () => '',
    takeFiller: () => null,
    createTts: () => ({
      label: 'fake voice',
      async synthesizeStream(text) {
        return { text };
      },
    }),
    createBrain: () => ({
      label: 'fake brain',
      async answer(_context, { onSentence }) {
        await release;
        onSentence('Listo.');
        return 'Listo.';
      },
    }),
  };
}

/** Just enough surface for ask() to run a turn to completion once released. */
function fakeSession(guildId) {
  return {
    guildId,
    agentEnabled: false,
    quiet: false,
    setQuiet() {},
    receiver: { buffer: { recent: () => [] } },
    startSpeech() {
      const spoken = [];
      let resolve;
      const finished = new Promise((r) => {
        resolve = r;
      });
      return {
        spoken,
        finished,
        push(_resource, text) {
          if (text) spoken.push(text);
        },
        end: () => resolve({ cancelled: false }),
        cancel: () => resolve({ cancelled: true }),
      };
    },
  };
}

describe('whenIdle', () => {
  test('resolves at once for a guild with nothing running', async () => {
    await whenIdle('nobody-asked-anything');
    assert.ok(true, 'reaching here at all is the assertion');
  });

  test("resolves only once the guild's running ask() settles", async () => {
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const session = fakeSession('g-when-idle');
    const running = ask(session, { question: 'hola', askedBy: 'Vero' }, deps(gate));

    let idle = false;
    whenIdle('g-when-idle').then(() => {
      idle = true;
    });

    // A couple of microtask turns: enough for whenIdle() to have resolved
    // already if it were ever (wrongly) going to before the brain answers.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(idle, false, 'must not resolve while the ask is still running');

    release();
    await running;
    await Promise.resolve();
    assert.equal(idle, true, "resolves once ask() reaches its own finally");
  });
});
