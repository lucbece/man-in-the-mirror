import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { ClaudeBrain, promptWithInstructions } from '../src/agent/brain.js';

/**
 * The chat brain's Anthropic call (`ClaudeBrain.answer`). Same item as
 * test/cascade-anthropic.test.js — item 15, docs/plans/performance.md — for
 * the other Anthropic call site in the repo. `client` is the constructor's
 * test seam; `createBrain` never passes one, so production always builds the
 * real SDK client.
 */

/** A fake `beta.messages.stream` that records the request and answers with nothing. */
function fakeAnthropicClient(finalMessage = { content: [], stop_reason: 'end_turn' }) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(body) {
          calls.push(body);
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
    },
  };
}

const ask = (question) => ({ question, askedBy: 'Vero', transcript: '' });

describe('ClaudeBrain — prompt caching', () => {
  test('sends the system prompt as one cached block, text unchanged', async () => {
    const client = fakeAnthropicClient();
    const brain = new ClaudeBrain({ apiKey: 'sk-ant-test', guildId: 'g', client });

    await brain.answer(ask('qué hora es en Tokio?'));

    assert.equal(client.calls.length, 1);
    const { system } = client.calls[0];
    assert.ok(Array.isArray(system), 'system must be a content-block array, not a bare string');
    assert.equal(system.length, 1, 'nothing after the cache breakpoint');
    const [block] = system;
    assert.equal(block.type, 'text');
    assert.deepEqual(block.cache_control, { type: 'ephemeral' });
    assert.equal(block.text, promptWithInstructions('g'));
  });

  test('the cached block is identical on a second turn', async () => {
    const client = fakeAnthropicClient();
    const brain = new ClaudeBrain({ apiKey: 'sk-ant-test', guildId: 'g', client });

    await brain.answer(ask('primera pregunta'));
    await brain.answer(ask('segunda pregunta, bien distinta'));

    assert.equal(client.calls.length, 2);
    const [first, second] = client.calls.map((c) => c.system[0].text);
    assert.equal(first, second, 'the system prefix must be byte-identical turn to turn for the cache to hit');
  });
});
