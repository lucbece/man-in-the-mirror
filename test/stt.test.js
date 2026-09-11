import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { OpenAiWhisper } from '../src/agent/stt.js';
import { DeadlineError, takeTimeouts } from '../src/agent/deadline.js';
import { pcmToWav } from '../src/agent/audio.js';

/**
 * `OpenAiWhisper` against an injected `fetch`, the same seam
 * `OpenAiAgentSession` uses (see openai-agent.js and its test): the
 * constructor takes `fetch = globalThis.fetch`, so a request that would
 * otherwise hang for real can be made to hang until its abort signal fires,
 * without touching the network or waiting out a real multi-second deadline.
 */

/** A `fetch` that never answers until the request's own signal aborts. */
function hangingFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(url);
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  return { calls, fetch };
}

const wav = () => pcmToWav(Buffer.alloc(16_000 * 2)); // 1s of silence

describe('OpenAiWhisper.transcribe honours deadlineMs, retries and stage', () => {
  test('deadlineMs overrides the size-based default', async () => {
    const { calls, fetch } = hangingFetch();
    const whisper = new OpenAiWhisper({ apiKey: 'sk-test', model: 'whisper-1', fetch });

    const started = Date.now();
    await assert.rejects(
      whisper.transcribe(wav(), { deadlineMs: 30, retries: 0 }),
      (err) => err instanceof DeadlineError && err.ms === 30,
    );
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 500, `took ${elapsed}ms — waited for the ~4.8s size-based default instead of the override`);
    assert.equal(calls.length, 1);
  });

  test('retries defaults to one, same as every existing call, and can be turned off', async () => {
    takeTimeouts();
    const first = hangingFetch();
    const withDefaultRetries = new OpenAiWhisper({ apiKey: 'sk-test', model: 'whisper-1', fetch: first.fetch });
    await assert.rejects(withDefaultRetries.transcribe(wav(), { deadlineMs: 20 }));
    assert.equal(first.calls.length, 2, 'no retries option passed — behaviour is unchanged: one retry');

    const second = hangingFetch();
    const noRetries = new OpenAiWhisper({ apiKey: 'sk-test', model: 'whisper-1', fetch: second.fetch });
    await assert.rejects(noRetries.transcribe(wav(), { deadlineMs: 20, retries: 0 }));
    assert.equal(second.calls.length, 1, 'retries: 0 gives up after the first miss');
  });

  test('stage defaults to stt and can be tallied under its own key', async () => {
    takeTimeouts();
    const { fetch } = hangingFetch();
    const whisper = new OpenAiWhisper({ apiKey: 'sk-test', model: 'whisper-1', fetch });

    await assert.rejects(
      whisper.transcribe(wav(), { deadlineMs: 20, retries: 0 }),
      (err) => err instanceof DeadlineError && err.stage === 'stt',
    );
    assert.deepEqual(takeTimeouts(), { stt: 1 }, 'no stage passed — behaviour is unchanged: tallied as stt');

    const confirming = hangingFetch();
    const confirmer = new OpenAiWhisper({ apiKey: 'sk-test', model: 'whisper-1', fetch: confirming.fetch });
    await assert.rejects(
      confirmer.transcribe(wav(), { deadlineMs: 20, retries: 0, stage: 'stt-confirm' }),
      (err) => err instanceof DeadlineError && err.stage === 'stt-confirm',
    );
    assert.deepEqual(takeTimeouts(), { 'stt-confirm': 1 }, 'a confirmation timeout must not count as a primary stt timeout');
  });
});
