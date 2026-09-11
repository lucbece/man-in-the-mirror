import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { config } from '../src/config.js';
import { CascadeBrain, FAST_PROMPT_EXTRA, resetCascade } from '../src/agent/cascade.js';
import { promptWithInstructions } from '../src/agent/brain.js';

/**
 * The fast leg's Anthropic branch (`#runFastAnthropic`). Item 15 in
 * docs/plans/performance.md: `cache_control` on the system prompt should
 * save 430ms to first token on every turn after the first, and only if the
 * prefix Anthropic hashes is byte-identical turn to turn. These tests cover
 * the request shape rather than the saving itself — that needs a real
 * account and was measured separately — using `deps.anthropicClient` as the
 * test seam, the same way `deps.fetch` stands in for the OpenAI leg in
 * test/cascade-openai.test.js.
 */

/** Mutates config for the duration of `fn`, never touching disk, then reverts. */
async function withConfig(seed, fn) {
  const snapshot = { ...config.values };
  const persist = config.persist;
  config.persist = () => {};
  try {
    Object.assign(config.values, seed);
    return await fn();
  } finally {
    config.persist = persist;
    config.values = snapshot;
  }
}

/** A fake `messages.stream` that records the request and answers with nothing. */
function fakeAnthropicClient(finalMessage = { content: [], stop_reason: 'end_turn' }) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(body, opts) {
        calls.push({ body, opts });
        return {
          on() {
            return this;
          },
          async finalMessage() {
            return finalMessage;
          },
        };
      },
    },
  };
}

function fakeAgent() {
  return {
    label: 'fake agent',
    async answer() {
      return 'agent answer';
    },
  };
}

const ask = (question) => ({ question, askedBy: 'Vero', transcript: '', utterances: [] });

describe('the Anthropic fast leg — prompt caching', () => {
  beforeEach(resetCascade);

  test('sends the system prompt as one cached block, text unchanged', async () => {
    const client = fakeAnthropicClient();

    await withConfig({ fastModel: 'claude-haiku-4-5', anthropicApiKey: 'sk-ant-test', openaiApiKey: '' }, () => {
      const b = new CascadeBrain({ guildId: 'g', deps: { agent: fakeAgent(), anthropicClient: client } });
      return b.answer(ask('de qué color es el cielo?'));
    });

    assert.equal(client.calls.length, 1);
    const { system } = client.calls[0].body;
    assert.ok(Array.isArray(system), 'system must be a content-block array, not a bare string');
    assert.equal(system.length, 1, 'nothing after the cache breakpoint');
    const [block] = system;
    assert.equal(block.type, 'text');
    assert.deepEqual(block.cache_control, { type: 'ephemeral' });
    // Same text the model was always given — only where it sits changed.
    assert.equal(block.text, promptWithInstructions('g', FAST_PROMPT_EXTRA));
  });

  test('the cached block is identical on a second turn, with no per-turn content in it', async () => {
    const client = fakeAnthropicClient();

    await withConfig({ fastModel: 'claude-haiku-4-5', anthropicApiKey: 'sk-ant-test', openaiApiKey: '' }, async () => {
      const b = new CascadeBrain({ guildId: 'g', deps: { agent: fakeAgent(), anthropicClient: client } });
      await b.answer(ask('primera pregunta'));
      await b.answer(ask('segunda pregunta, bien distinta'));
    });

    assert.equal(client.calls.length, 2);
    const [first, second] = client.calls.map((c) => c.body.system[0].text);
    assert.equal(first, second, 'the system prefix must be byte-identical turn to turn for the cache to hit');
  });
});
