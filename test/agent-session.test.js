import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AgentSession, TURN_TIMEOUT_MS } from '../src/agent/agent-brain.js';

/**
 * The session, against a fake message stream.
 *
 * Everything worth testing here is how this class *reads* the protocol: when a
 * sentence is complete enough to speak, when a flush is owed, which result
 * subtypes are an answer and which are a failure, and what happens when the
 * stream dies mid-question. Against a real subprocess that would be testing
 * the SDK; against a fake stream it is testing us.
 */
function fakeSdk() {
  const outbox = [];
  const sent = [];
  let wake = null;
  let ended = false;

  const sdk = {
    sent,
    interrupted: 0,
    options: null,

    /** Emit one protocol message to the session's pump. */
    emit(message) {
      outbox.push(message);
      wake?.();
      wake = null;
      return new Promise((resolve) => { setImmediate(resolve); });
    },

    /** The subprocess exiting on its own. */
    end() {
      ended = true;
      wake?.();
      wake = null;
      return new Promise((resolve) => { setImmediate(resolve); });
    },

    run({ prompt, options }) {
      sdk.options = options;
      // The SDK pulls user messages; record what it would have been given.
      (async () => {
        for await (const message of prompt) sent.push(message);
      })().catch(() => {});

      return {
        interrupt: () => { sdk.interrupted += 1; },
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
  return sdk;
}

const session = (sdk, opts = {}) => new AgentSession({ signature: 'sig', run: sdk.run, ...opts });

const delta = (text) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});
const assistant = (...content) => ({ type: 'assistant', message: { content } });
const result = (extra) => ({ type: 'result', subtype: 'success', ...extra });

describe('answering', () => {
  test('speaks sentences as they complete, and returns the whole reply', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const spoken = [];
    const answer = s.ask('¿qué opinás?', { onSentence: (c) => spoken.push(c) });

    // Over MIN_CHUNK, or the splitter holds it back on purpose: a three-word
    // sentence rendered alone is a bark followed by a pause.
    await sdk.emit(delta('Me parece una buena idea, la verdad. '));
    await sdk.emit(delta('Aunque depende del server.'));
    assert.deepEqual(
      spoken,
      ['Me parece una buena idea, la verdad.'],
      'the first one goes out before the rest exists',
    );

    await sdk.emit(result({ result: 'Me parece una buena idea, la verdad. Aunque depende del server.' }));

    assert.equal(await answer, 'Me parece una buena idea, la verdad. Aunque depende del server.');
    assert.deepEqual(spoken, ['Me parece una buena idea, la verdad.', 'Aunque depende del server.']);
  });

  test('flushes at the end of a message, so two messages do not glue together', async (t) => {
    // The bug: "dame un segundo que me fijo.Hay tres archivos" — the deltas
    // carry no separator across a tool call, so whatever is held back when a
    // message finishes has to go out then.
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const spoken = [];
    const answer = s.ask('q', { onSentence: (c) => spoken.push(c) });

    await sdk.emit(delta('Dame un segundo que me fijo'));
    await sdk.emit(assistant({ type: 'text', text: 'Dame un segundo que me fijo' }));
    assert.deepEqual(spoken, ['Dame un segundo que me fijo'], 'held text goes out at the boundary');

    await sdk.emit(delta('Hay tres archivos.'));
    await sdk.emit(result({ result: 'Hay tres archivos.' }));
    await answer;

    assert.deepEqual(spoken, ['Dame un segundo que me fijo', 'Hay tres archivos.']);
  });

  test('reports every tool it reaches for', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const tools = [];
    const answer = s.ask('q', { onToolUse: (n) => tools.push(n) });

    await sdk.emit(assistant(
      { type: 'tool_use', name: 'mcp__bot__search_web' },
      { type: 'tool_use', name: 'mcp__files__read_text_file' },
    ));
    await sdk.emit(result({ result: 'listo' }));
    await answer;

    assert.deepEqual(tools, ['mcp__bot__search_web', 'mcp__files__read_text_file']);
  });

  test('keeps what it costs and how many it has answered', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const answer = s.ask('q');
    await sdk.emit(result({ result: 'ok', total_cost_usd: 0.042 }));
    await answer;

    assert.equal(s.spentUsd, 0.042);
    assert.equal(s.answers, 1);
  });
});

describe('when the run does not finish cleanly', () => {
  test('a truncated run still says the last thing it managed', async (t) => {
    // error_max_turns carries no result text, but the last thing it said
    // usually stands on its own — better than silence.
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const answer = s.ask('q');
    await sdk.emit(assistant({ type: 'text', text: 'Encontré tres cosas' }));
    await sdk.emit({ type: 'result', subtype: 'error_max_turns' });

    assert.equal(await answer, 'Encontré tres cosas');
  });

  test('a real failure rejects, naming what went wrong', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const failed = s.ask('q').then(() => null, (err) => err);
    await sdk.emit({ type: 'result', subtype: 'error', errors: ['mcp server died'] });

    assert.match((await failed).message, /mcp server died/);
  });

  test('the subprocess ending mid-question fails that question', async (t) => {
    // Not left hanging: ask() is awaited by the pipeline that holds the
    // one-at-a-time guard for the guild.
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const failed = s.ask('q').then(() => null, (err) => err);
    await sdk.end();

    assert.match((await failed).message, /session ended/i);
    assert.equal(s.closed, true, 'and the session is closed, not silently reused');
  });

  test('a closed session refuses politely instead of hanging', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    s.end();
    await assert.rejects(() => s.ask('q'), /closed/i);
  });

  test('two questions at once is refused, not interleaved', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const first = s.ask('primera');
    await assert.rejects(() => s.ask('segunda'), /mid-answer/i);

    await sdk.emit(result({ result: 'ok' }));
    assert.equal(await first, 'ok');
  });

  test('a wedged run is killed rather than left wedged for the next question', async (t) => {
    // A hung MCP server or a runaway loop. Ending the session is the point:
    // the wedge must not outlive the question that hit it.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sdk = fakeSdk();
    const s = session(sdk);

    const failed = s.ask('q').then(() => null, (err) => err);
    t.mock.timers.tick(TURN_TIMEOUT_MS);

    assert.match((await failed).message, /over two minutes/);
    assert.equal(s.closed, true);
    assert.equal(sdk.interrupted, 1, 'and the run in flight is interrupted');
  });
});

describe('the input side', () => {
  test('the question reaches the SDK as a user message', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const answer = s.ask('¿quién ganó?');
    await sdk.emit(result({ result: 'ok' }));
    await answer;

    assert.equal(sdk.sent.length, 1);
    assert.equal(sdk.sent[0].type, 'user');
    assert.equal(sdk.sent[0].message.content, '¿quién ganó?');
  });

  test('ending interrupts the run rather than waiting it out', async () => {
    const sdk = fakeSdk();
    const s = session(sdk);

    s.end();
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(sdk.interrupted, 1);
    s.end();
    assert.equal(sdk.interrupted, 1, 'ending twice must not double-interrupt');
  });
});
