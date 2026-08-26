/**
 * What the last few answers cost, kept in memory.
 *
 * Every answer already computes its own timings and already knows whether it
 * reached for a tool — `index.js` prints both and then drops them. That
 * discarded pair is the only ground truth there is for a question the bot
 * cannot otherwise answer about itself: how often does a turn actually need
 * the agent, and what does the agent cost when it isn't needed. Keeping it is
 * the difference between choosing a routing strategy on measurement and
 * choosing one on a hunch.
 *
 * No question text and no answer text, ever — only which brain ran, which
 * tools it used, and how long each stage took. The audio buffer never reaches
 * disk and neither does this; the point of the file is that it can be kept
 * without keeping anything that was said.
 */

/** Enough to see a pattern in one call, small enough to be free. */
const KEEP = 60;

const records = [];

/**
 * Record one finished answer.
 *
 * `tools` is the set of tool names used, so "did this need the agent" is a
 * fact rather than an inference — a turn that used nothing could have been
 * answered by anything.
 */
export function recordAnswer({ brain, model, tools = [], escalated = false, followUp = false, timings = {} }) {
  records.push({
    at: Date.now(),
    brain,
    model,
    tools: [...tools],
    usedTools: tools.length > 0,
    escalated,
    followUp,
    firstAudioMs: timings.firstAudioMs ?? null,
    beforeAskMs: timings.beforeAskMs ?? null,
    thinkMs: timings.thinkMs ?? null,
    totalMs: timings.totalMs ?? null,
  });
  if (records.length > KEEP) records.splice(0, records.length - KEEP);
}

export function recentAnswers() {
  return records.slice();
}

/** Only for tests — the buffer is process-wide by design. */
export function resetAnswers() {
  records.length = 0;
}

function median(numbers) {
  const sorted = numbers.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The summary the panel shows, and the number the routing question turns on.
 *
 * `toolRate` is the share of answers that used a tool. Its complement is the
 * share a model with no tools at all could have handled — which is what
 * decides whether putting a fast model in front is worth anything. Medians
 * rather than means: one twenty-second search would otherwise move the
 * average enough to hide everything else.
 */
export function answerStats() {
  if (!records.length) return { count: 0 };

  const withTools = records.filter((r) => r.usedTools);
  const withoutTools = records.filter((r) => !r.usedTools);
  const escalated = records.filter((r) => r.escalated);
  // Answers that came from the bot's own question rather than from its name.
  // Worth a number rather than a feeling: this is the path that can make it
  // speak when nobody addressed it.
  const followUps = records.filter((r) => r.followUp);

  return {
    count: records.length,
    toolRate: withTools.length / records.length,
    escalationRate: escalated.length / records.length,
    followUpRate: followUps.length / records.length,
    firstAudioMs: median(records.map((r) => r.firstAudioMs)),
    // The wake chain: silence detection, transcription, the grace wait. Only
    // present for answers that came from someone speaking — a question typed
    // into the panel never waited for any of it.
    beforeAskMs: median(records.map((r) => r.beforeAskMs)),
    firstAudioWithToolsMs: median(withTools.map((r) => r.firstAudioMs)),
    firstAudioWithoutToolsMs: median(withoutTools.map((r) => r.firstAudioMs)),
    totalMs: median(records.map((r) => r.totalMs)),
    tools: Object.entries(
      records.flatMap((r) => r.tools).reduce((counts, name) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return counts;
      }, {}),
    )
      .sort((a, b) => b[1] - a[1])
      .map(([name, times]) => ({ name, times })),
  };
}
