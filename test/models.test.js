import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { MODELS, costOf, providerFor } from '../src/agent/models.js';

/**
 * The known set the panel's selects are built from. Free-typed model ids stay
 * accepted everywhere they are today — this file is only asserting the shape
 * of the list, since config.js does not validate against it.
 */
describe('the known models', () => {
  test('every entry has the fields a select and a note need', () => {
    for (const model of MODELS) {
      assert.equal(typeof model.id, 'string');
      assert.ok(['anthropic', 'openai'].includes(model.provider), model.id);
      assert.equal(typeof model.label, 'string');
      assert.ok(Array.isArray(model.role) && model.role.length > 0, model.id);
      for (const role of model.role) {
        assert.ok(['agent', 'fast', 'chat'].includes(role), `${model.id}: ${role}`);
      }
      assert.equal(typeof model.note, 'string');
      assert.ok(model.note.length > 0, model.id);
      // The agent bills itself from these on the OpenAI side, so a missing or
      // zeroed price is a spend figure that silently reads $0.00 forever.
      assert.ok(model.pricePerMillion.input > 0, model.id);
      assert.ok(model.pricePerMillion.output > 0, model.id);
    }
  });

  test('ids are unique', () => {
    const ids = MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('the five models from the plan, in the roles they were assigned', () => {
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));

    assert.deepEqual(byId['claude-haiku-4-5'].role.sort(), ['chat', 'fast']);
    assert.deepEqual(byId['claude-sonnet-5'].role.sort(), ['agent', 'chat', 'fast']);
    assert.deepEqual(byId['claude-opus-5'].role.sort(), ['agent', 'chat']);
    // Both OpenAI ids gained the agent role when the agent stopped being
    // Claude-only; the Claude assignments are unchanged.
    assert.deepEqual(byId['gpt-4.1'].role.sort(), ['agent', 'chat', 'fast']);
    assert.deepEqual(byId['gpt-4.1-mini'].role.sort(), ['agent', 'chat', 'fast']);

    assert.equal(byId['claude-haiku-4-5'].provider, 'anthropic');
    assert.equal(byId['claude-sonnet-5'].provider, 'anthropic');
    assert.equal(byId['claude-opus-5'].provider, 'anthropic');
    assert.equal(byId['gpt-4.1'].provider, 'openai');
    assert.equal(byId['gpt-4.1-mini'].provider, 'openai');
  });

  test('the notes carry the measured timings rather than an invented one', () => {
    const byId = Object.fromEntries(MODELS.map((m) => [m.id, m]));
    assert.match(byId['claude-haiku-4-5'].note, /2\.4s/);
    assert.match(byId['claude-sonnet-5'].note, /4\.9s/);
  });
});

describe('providerFor', () => {
  test('known ids come from the list rather than a guess', () => {
    assert.equal(providerFor('claude-sonnet-5'), 'anthropic');
    assert.equal(providerFor('claude-haiku-4-5'), 'anthropic');
    assert.equal(providerFor('gpt-4.1'), 'openai');
    assert.equal(providerFor('gpt-4.1-mini'), 'openai');
  });

  test('an unlisted claude id still resolves by prefix', () => {
    assert.equal(providerFor('claude-opus-6'), 'anthropic');
  });

  test('an unlisted OpenAI id resolves by prefix', () => {
    assert.equal(providerFor('gpt-5-mini'), 'openai');
    assert.equal(providerFor('o1-preview'), 'openai');
    assert.equal(providerFor('o3-mini'), 'openai');
    assert.equal(providerFor('o4-mini'), 'openai');
    assert.equal(providerFor('chatgpt-4o-latest'), 'openai');
  });

  test('anything else is neither', () => {
    assert.equal(providerFor('llama-3'), null);
    assert.equal(providerFor(''), null);
    assert.equal(providerFor(undefined), null);
  });
});

describe('what a turn cost', () => {
  test('is the published list price for the tokens the API reported', () => {
    // gpt-4.1 at $2 in and $8 out per million.
    assert.ok(Math.abs(costOf('gpt-4.1', { input: 1_000_000, output: 0 }) - 2) < 1e-9);
    assert.ok(Math.abs(costOf('gpt-4.1', { input: 0, output: 1_000_000 }) - 8) < 1e-9);
    // claude-sonnet-5 at $2 in and $10 out.
    assert.ok(Math.abs(costOf('claude-sonnet-5', { input: 0, output: 1_000_000 }) - 10) < 1e-9);
  });

  test('an id with no price costs zero rather than a guess', () => {
    assert.equal(costOf('llama-3-70b', { input: 1_000_000, output: 1_000_000 }), 0);
    assert.equal(costOf('gpt-4.1'), 0, 'no tokens, no cost');
  });
});
