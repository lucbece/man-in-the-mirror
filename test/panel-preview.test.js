import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { scenarios } from '../scripts/panel-preview.mjs';
import { config } from '../src/config.js';

/**
 * The one thing that can quietly rot: the fake `/api/state` drifting from the
 * real one's shape while nobody looks at the preview for a while. This
 * doesn't check every value, only that `config` carries exactly the keys
 * `config.publicView()` sends — which is what a panel built against the
 * preview would actually break on — and that the other top-level fields are
 * there at all.
 */
describe('panel preview fake state', () => {
  const realConfigKeys = Object.keys(config.publicView()).sort();

  for (const [name, state] of Object.entries(scenarios)) {
    test(`${name}: config has exactly the keys the real /api/state sends`, () => {
      assert.deepEqual(Object.keys(state.config).sort(), realConfigKeys);
    });

    test(`${name}: carries bot, guilds, sessions and answers`, () => {
      assert.ok(state.bot, 'missing bot');
      assert.ok(Array.isArray(state.guilds), 'guilds should be an array');
      assert.ok(Array.isArray(state.sessions), 'sessions should be an array');
      assert.ok(state.answers, 'missing answers');
    });
  }
});
