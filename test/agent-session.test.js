import assert from 'node:assert/strict';
import { AGENT_FIRST_BLOCK_MS } from '../src/agent/deadline.js';
import { verifyKey, AgentError } from '../src/agent/agent-brain.js';
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
/** An assistant message the SDK has flagged as an API error rather than text the model chose to say. */
const assistantError = (error, ...content) => ({ type: 'assistant', message: { content }, error });
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

describe('a credit-exhausted account, measured 2026-09-06..10', () => {
  test('an API error dressed as text is never spoken and rejects the turn with code "api"', async (t) => {
    // 2026-09-09 19:36–19:38: the SDK delivered the billing failure as an
    // assistant message whose text was "Credit balance is too low", then a
    // result with subtype 'success'. It streamed like any other text too —
    // it is sitting in the splitter, unflushed, when the assistant message
    // naming it an error arrives — so both the flush that message would
    // normally get and the fallback lastText it would normally leave behind
    // have to be guarded, not just the subtype the result reports.
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const spoken = [];
    const failed = s.ask('q', { onSentence: (c) => spoken.push(c) }).then(() => null, (err) => err);

    await sdk.emit(delta('Credit balance is too low'));
    await sdk.emit(assistantError('billing_error', { type: 'text', text: 'Credit balance is too low' }));
    await sdk.emit(result({ result: 'Credit balance is too low' }));

    const err = await failed;
    assert.equal(err.code, 'api');
    assert.equal(err.apiError, 'billing_error');
    assert.deepEqual(spoken, [], 'the error text must never reach onSentence');
  });

  test('a success with no text, no tool use and no new spend is a dead turn', async (t) => {
    // 2026-09-10: 22 of 23 agent results that day were exactly this —
    // subtype 'success', no text, no tool use, $0.0000 so far — and the
    // room heard silence for every request that needed a tool.
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const failed = s.ask('q').then(() => null, (err) => err);
    await sdk.emit(result({ result: '', total_cost_usd: 0 }));

    const err = await failed;
    assert.equal(err.code, 'dead');
  });

  test('unchanged cost from an earlier nonzero spend is still a dead turn', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const first = s.ask('q1');
    await sdk.emit(result({ result: 'ok', total_cost_usd: 0.01 }));
    await first;

    const failed = s.ask('q2').then(() => null, (err) => err);
    await sdk.emit(result({ result: '', total_cost_usd: 0.01 })); // unchanged from the previous result
    assert.equal((await failed).code, 'dead');
  });

  test('a success with a cost delta still resolves, even with no text and no tools', async (t) => {
    // The one thing that must not become collateral damage: a real turn
    // that spent something is left alone, whatever it did or didn't say.
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const answer = s.ask('q');
    await sdk.emit(result({ result: '', total_cost_usd: 0.003 }));

    assert.equal(await answer, '');
  });

  test('text still resolves normally alongside a cost delta', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const answer = s.ask('q');
    await sdk.emit(result({ result: 'Tres archivos.', total_cost_usd: 0.003 }));

    assert.equal(await answer, 'Tres archivos.');
  });

  test('consecutive failures of these two kinds are counted, and a healthy turn resets it', async (t) => {
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const first = s.ask('q1').catch(() => {});
    await sdk.emit(result({ result: '', total_cost_usd: 0 }));
    await first;
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastErrorCode, 'dead');

    const second = s.ask('q2').catch(() => {});
    await sdk.emit(assistantError('rate_limit'));
    await sdk.emit(result({ result: '' }));
    await second;
    assert.equal(s.consecutiveFailures, 2);
    assert.equal(s.lastErrorCode, 'api');

    const third = s.ask('q3');
    await sdk.emit(result({ result: 'ok', total_cost_usd: 0.01 }));
    await third;
    assert.equal(s.consecutiveFailures, 0, 'a healthy turn resets the run');
    assert.equal(s.lastErrorCode, 'api', 'but the last error itself is not erased by recovering');
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
    // the wedge must not outlive the question that hit it. The run has begun
    // answering, so the shorter first-block deadline does not apply.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sdk = fakeSdk();
    const s = session(sdk);

    const failed = s.ask('q').then(() => null, (err) => err);
    await sdk.emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } });
    t.mock.timers.tick(TURN_TIMEOUT_MS);

    assert.match((await failed).message, /over two minutes/);
    assert.equal(s.closed, true);
    assert.equal(sdk.interrupted, 1, 'and the run in flight is interrupted');
  });

  test('no content block in fifteen seconds ends the turn, and the session lives on', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sdk = fakeSdk();
    const s = session(sdk);
    t.after(() => s.end());

    const failed = s.ask('q').then(() => null, (err) => err);
    t.mock.timers.tick(AGENT_FIRST_BLOCK_MS);

    assert.match((await failed).message, /no answer in 15s/);
    assert.equal(s.closed, false, 'the conversation is kept');
    assert.equal(sdk.interrupted, 1, 'the run in flight is interrupted');

    // The interrupted run's own result arrives late and belongs to nobody;
    // the next question gets its own answer, not that one.
    const next = s.ask('q2');
    await sdk.emit(result({ result: 'stale' }));
    await sdk.emit(result({ result: 'fresh' }));
    assert.equal(await next, 'fresh');
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

describe('the key check', () => {
  const answering = (status) => async () => new Response('{}', { status });
  test('a 401 or 403 is a rejected key; anything else is not held against it', async () => {
    assert.equal(await verifyKey('anthropic', 'k', { fetchImpl: answering(401) }), 'rejected');
    assert.equal(await verifyKey('openai', 'k', { fetchImpl: answering(403) }), 'rejected');
    assert.equal(await verifyKey('anthropic', 'k', { fetchImpl: answering(200) }), 'ok');
    assert.equal(await verifyKey('anthropic', 'k', { fetchImpl: answering(500) }), 'unknown');
    assert.equal(await verifyKey('openai', 'k', { fetchImpl: async () => { throw new Error('offline'); } }), 'unknown');
  });

  test('a doomed session refuses every later question with the reason', async () => {
    const sdk = fakeSdk();
    const s = session(sdk);
    s.doom(new AgentError('Anthropic rejected the API key. Fix it in the panel under Keys.'));
    await assert.rejects(s.ask('q'), /rejected the API key/);
    assert.equal(s.closed, true);
  });
});
