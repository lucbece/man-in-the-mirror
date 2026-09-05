import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { config } from '../src/config.js';
import { CascadeBrain, resetCascade } from '../src/agent/cascade.js';

/**
 * The fast leg dispatches on `fastModel`'s provider (`src/agent/models.js`,
 * `providerFor`). These tests cover the OpenAI branch — a room whose key is
 * OpenAI's can still put a fast model in front of the (always Claude) agent.
 * `deps.fetch` stands in for the network, the same way `deps.runFast` stands
 * in for the whole fast leg in `test/cascade.test.js`; nothing here reaches
 * the network.
 */

/** Mutates config for the duration of `fn`, never touching disk, then reverts. */
async function withConfig(seed, fn) {
  const snapshot = { ...config.values };
  const persist = config.persist;
  config.persist = () => {};
  try {
    Object.assign(config.values, seed);
    // Awaited, or the finally below restores the config before the body has
    // reached its first read past an await.
    return await fn();
  } finally {
    config.persist = persist;
    config.values = snapshot;
  }
}

/** A `fetch` Response streaming the given Responses-API events as SSE. */
function sseResponse(events, { status = 200 } = {}) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status });
}

const textDelta = (delta) => ({ type: 'response.output_text.delta', delta });
const escalateCall = (reason) => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', name: 'escalate', arguments: JSON.stringify({ reason }) },
});

function fakeAgent() {
  const calls = [];
  return {
    calls,
    label: 'fake agent',
    async answer(context, handlers) {
      calls.push(context);
      handlers.onSentence?.('agent answer');
      return 'agent answer';
    },
  };
}

const ask = (question) => ({ question, askedBy: 'Vero', transcript: '', utterances: [] });

describe('the OpenAI fast leg', () => {
  beforeEach(resetCascade);

  test('an OpenAI fast model that answers streams sentences and keeps the turn', async () => {
    let calledWith = null;
    const deps = {
      agent: fakeAgent(),
      fetch: async (url, opts) => {
        calledWith = { url, body: JSON.parse(opts.body) };
        return sseResponse([textDelta('Porque sí.')]);
      },
    };

    await withConfig({ openaiApiKey: 'sk-test', fastModel: 'gpt-4.1-mini', anthropicApiKey: '' }, async () => {
      const b = new CascadeBrain({ guildId: 'g', deps });
      const spoken = [];
      const text = await b.answer(ask('por qué?'), { onSentence: (s) => spoken.push(s) });

      assert.equal(text, 'Porque sí.');
      assert.equal(b.escalated, false);
      assert.equal(deps.agent.calls.length, 0, 'the agent must not have been asked');
      assert.deepEqual(spoken, ['Porque sí.']);

      assert.equal(calledWith.url, 'https://api.openai.com/v1/responses');
      assert.equal(calledWith.body.model, 'gpt-4.1-mini');
      assert.equal(calledWith.body.stream, true);
      assert.ok(calledWith.body.tools.some((t) => t.name === 'escalate'));
    });
  });

  test('a function call to escalate hands over, with any text said first', async () => {
    const agent = fakeAgent();
    const deps = {
      agent,
      fetch: async () => sseResponse([textDelta('Un segundo.'), escalateCall('needs a tool')]),
    };

    await withConfig({ openaiApiKey: 'sk-test', fastModel: 'gpt-4.1-mini', anthropicApiKey: '' }, async () => {
      const b = new CascadeBrain({ guildId: 'g', deps });
      const spoken = [];
      await b.answer(ask('qué hora es en Tokio?'), { onSentence: (s) => spoken.push(s) });

      assert.equal(b.escalated, true);
      assert.equal(b.reason, 'needs a tool');
      // 'agent answer' is the fake agent continuing the turn; the fast leg's
      // own contribution is only the holding line said before the handover.
      assert.deepEqual(spoken, ['Un segundo.', 'agent answer']);
      assert.equal(agent.calls[0].alreadySaid, 'Un segundo.');
    });
  });

  test('no OpenAI key escalates without ever calling fetch', async () => {
    const agent = fakeAgent();
    let fetchCalled = false;
    const deps = { agent, fetch: async () => { fetchCalled = true; } };

    await withConfig({ openaiApiKey: '', fastModel: 'gpt-4.1-mini', anthropicApiKey: '' }, async () => {
      const b = new CascadeBrain({ guildId: 'g', deps });
      await b.answer(ask('q'));

      assert.equal(b.escalated, true);
      assert.equal(b.reason, 'no OpenAI key for the fast model');
      assert.equal(fetchCalled, false);
    });
  });

  test('an unknown model id escalates without calling fetch or the Anthropic SDK', async () => {
    const agent = fakeAgent();
    let fetchCalled = false;
    const deps = { agent, fetch: async () => { fetchCalled = true; } };

    await withConfig(
      { openaiApiKey: 'sk-test', anthropicApiKey: 'sk-ant-test', fastModel: 'llama-3-70b' },
      async () => {
        const b = new CascadeBrain({ guildId: 'g', deps });
        await b.answer(ask('q'));

        assert.equal(b.escalated, true);
        assert.match(b.reason, /llama-3-70b/);
        assert.equal(fetchCalled, false);
      },
    );
  });
});

describe('the Anthropic fast leg still dispatches correctly', () => {
  beforeEach(resetCascade);

  test('a Claude fast model with no Anthropic key escalates, untouched by the OpenAI change', async () => {
    // No `deps.fetch`, no `deps.runFast` — this exercises the real
    // dispatch (`providerFor` → the Anthropic branch) and returns before any
    // network call, since the key is blank.
    const agent = fakeAgent();
    await withConfig({ anthropicApiKey: '', openaiApiKey: '', fastModel: 'claude-haiku-4-5' }, async () => {
      const b = new CascadeBrain({ guildId: 'g', deps: { agent } });
      await b.answer(ask('q'));

      assert.equal(b.escalated, true);
      assert.equal(b.reason, 'no Anthropic key for the fast model');
    });
  });
});
