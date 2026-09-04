import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { MODELS } from '../src/agent/models.js';

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
    assert.deepEqual(byId['gpt-4.1'].role, ['chat']);
    assert.deepEqual(byId['gpt-4.1-mini'].role, ['chat']);

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
