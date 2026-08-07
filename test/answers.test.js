import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { answerStats, recentAnswers, recordAnswer, resetAnswers } from '../src/agent/answers.js';

function answer({ tools = [], firstAudioMs = 2000, escalated = false } = {}) {
  recordAnswer({
    brain: 'test',
    model: 'test-model',
    tools,
    escalated,
    timings: { firstAudioMs, thinkMs: firstAudioMs, totalMs: firstAudioMs + 1000 },
  });
}

describe('what the last few answers cost', () => {
  beforeEach(resetAnswers);

  test('nothing to say before anything has been answered', () => {
    assert.deepEqual(answerStats(), { count: 0 });
  });

  test('the number the routing question turns on: how many needed no tool', () => {
    answer({ tools: [] });
    answer({ tools: [] });
    answer({ tools: ['mcp__bot__set_reminder'] });
    answer({ tools: [] });

    const stats = answerStats();
    assert.equal(stats.count, 4);
    assert.equal(stats.toolRate, 0.25);
  });

  test('splits the timing by whether tools were involved', () => {
    // Pooling them hides the whole point: the tool-using answers are the slow
    // ones, and their cost is exactly what a fast path would not pay.
    answer({ tools: [], firstAudioMs: 2000 });
    answer({ tools: [], firstAudioMs: 2400 });
    answer({ tools: ['x'], firstAudioMs: 9000 });

    const stats = answerStats();
    assert.equal(stats.firstAudioWithoutToolsMs, 2200);
    assert.equal(stats.firstAudioWithToolsMs, 9000);
  });

  test('medians, so one long search does not move everything', () => {
    answer({ firstAudioMs: 2000 });
    answer({ firstAudioMs: 2100 });
    answer({ firstAudioMs: 60_000 });
    assert.equal(answerStats().firstAudioMs, 2100);
  });

  test('counts which tools actually get used, most used first', () => {
    answer({ tools: ['search_web'] });
    answer({ tools: ['search_web', 'set_reminder'] });
    assert.deepEqual(answerStats().tools, [
      { name: 'search_web', times: 2 },
      { name: 'set_reminder', times: 1 },
    ]);
  });

  test('keeps nothing that was said', () => {
    // The audio buffer never reaches disk and neither does this; the file is
    // only worth having if it can be kept without keeping any of the content.
    answer({ tools: ['x'] });
    const [record] = recentAnswers();
    const fields = Object.keys(record);
    for (const forbidden of ['question', 'answer', 'text', 'transcript', 'spoken']) {
      assert.ok(!fields.includes(forbidden), `must not record ${forbidden}`);
    }
  });

  test('stays bounded however long the call runs', () => {
    for (let i = 0; i < 500; i += 1) answer();
    assert.ok(recentAnswers().length <= 60, 'must not grow without limit');
    assert.equal(answerStats().count, recentAnswers().length);
  });
});
