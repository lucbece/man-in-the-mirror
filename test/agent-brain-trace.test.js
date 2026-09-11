import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

/**
 * The `TURN` trace line now reports the Agent SDK's own cache usage (item 15,
 * docs/plans/performance.md — the SDK manages its own prefix, this file only
 * has to make that visible in production logs). `trace.js` reads
 * `MIRROR_TRACE` once, at import, so this file sets it before dynamically
 * importing `agent-brain.js` — the same trick test/trace.test.js uses, here
 * applied one module up so the real call site is exercised rather than the
 * formatter alone. `node --test` runs each file in its own process (checked
 * against this repo's `npm test`), so the plain `trace.js` specifier
 * `agent-brain.js` imports has not been touched by anything else yet.
 */

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = original;
  }).then(() => chunks.join(''));
}

/** A minimal copy of agent-session.test.js's fake SDK — just enough to reach one result. */
function fakeSdk() {
  const outbox = [];
  let wake = null;
  let ended = false;
  return {
    emit(message) {
      outbox.push(message);
      wake?.();
      wake = null;
      return new Promise((resolve) => { setImmediate(resolve); });
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    run() {
      return {
        interrupt: () => {},
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (outbox.length) yield outbox.shift();
            if (ended) return;
            await new Promise((resolve) => { wake = resolve; });
          }
        },
      };
    },
  };
}

describe('TURN trace line — SDK cache usage', () => {
  test('reports cache_read_input_tokens and cache_creation_input_tokens from the result message', async () => {
    process.env.MIRROR_TRACE = 'stdout';
    let AgentSession;
    try {
      ({ AgentSession } = await import('../src/agent/agent-brain.js'));
    } finally {
      delete process.env.MIRROR_TRACE;
    }

    const sdk = fakeSdk();
    const s = new AgentSession({ signature: 'sig', run: sdk.run });

    const text = await captureStdout(async () => {
      const answer = s.ask('q');
      await sdk.emit({
        type: 'result',
        subtype: 'success',
        result: 'ok',
        num_turns: 1,
        duration_ms: 500,
        total_cost_usd: 0.01,
        usage: { cache_read_input_tokens: 12034, cache_creation_input_tokens: 0 },
      });
      await answer;
      sdk.end();
    });

    assert.match(text, /TURN\s+success/);
    assert.match(text, /cache read 12034 \/ wrote 0/);
  });
});
