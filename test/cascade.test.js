import assert from 'node:assert/strict';
import test, { describe, beforeEach } from 'node:test';

import { CascadeBrain, resetCascade } from '../src/agent/cascade.js';

/** A fast leg that answers, or defers, without an API call. */
function fast(result) {
  return async (context, memory, { onSentence } = {}) => {
    if (result.said) onSentence?.(result.said);
    return { said: '', escalate: false, reason: null, ...result, seen: { context, memory } };
  };
}

/** An agent that records what it was handed and reports which tools it used. */
function fakeAgent({ tools = [], text = 'agent answer' } = {}) {
  const calls = [];
  return {
    calls,
    label: 'fake agent',
    async answer(context, handlers) {
      calls.push(context);
      for (const name of tools) handlers.onToolUse?.(name);
      handlers.onSentence?.(text);
      return text;
    },
  };
}

function brain(deps) {
  return new CascadeBrain({ guildId: 'g', deps });
}

const ask = (question) => ({ question, askedBy: 'Luc', transcript: '', utterances: [] });

describe('the fast leg keeping a turn', () => {
  beforeEach(resetCascade);

  test('answers without the agent ever being built', () => {
    const agent = fakeAgent();
    const b = brain({ agent, runFast: fast({ said: 'Porque sí.' }) });
    return b.answer(ask('por qué?')).then((text) => {
      assert.equal(text, 'Porque sí.');
      assert.equal(agent.calls.length, 0, 'the agent must not have been asked');
      assert.equal(b.escalated, false);
    });
  });

  test('speaks as it goes, which is the whole point of it being in front', async () => {
    const spoken = [];
    await brain({ agent: fakeAgent(), runFast: fast({ said: 'Ya te digo.' }) }).answer(
      ask('dale'),
      { onSentence: (s) => spoken.push(s) },
    );
    assert.deepEqual(spoken, ['Ya te digo.']);
  });
});

describe('handing over', () => {
  beforeEach(resetCascade);

  test('the agent continues from what was already said out loud', async () => {
    // It has been spoken into the channel and cannot be taken back, so the
    // only useful thing to do with it is carry on from it.
    const agent = fakeAgent();
    const b = brain({
      agent,
      runFast: fast({ said: 'Dame un segundo.', escalate: true, reason: 'needs a tool' }),
    });
    await b.answer(ask('qué hora es en Tokio?'));

    assert.equal(b.escalated, true);
    assert.equal(b.reason, 'needs a tool');
    assert.equal(agent.calls[0].alreadySaid, 'Dame un segundo.');
  });

  test('a fast leg that said nothing hands over nothing', async () => {
    const agent = fakeAgent();
    await brain({ agent, runFast: fast({ escalate: true, reason: 'x' }) }).answer(ask('q'));
    assert.equal(agent.calls[0].alreadySaid, null);
  });
});

describe('one conversation, not two', () => {
  beforeEach(resetCascade);

  test('the agent is told what was answered without it, once', async () => {
    // Nothing transcribes the bot, so an answer exists only where it was
    // produced. Without this the agent would meet a room referring to a
    // conversation it was never part of.
    const agent = fakeAgent();
    const answered = brain({ agent, runFast: fast({ said: 'Rojo.' }) });
    await answered.answer(ask('de qué color?'));

    const escalating = brain({ agent, runFast: fast({ escalate: true, reason: 'tool' }) });
    await escalating.answer(ask('y guardá eso'));

    assert.deepEqual(agent.calls[0].asides, [{ question: 'de qué color?', answer: 'Rojo.' }]);

    // Handed over once: the session remembers what it is told, so repeating it
    // would replay the same conversation.
    const again = brain({ agent, runFast: fast({ escalate: true, reason: 'tool' }) });
    await again.answer(ask('otra'));
    assert.deepEqual(agent.calls[1].asides, []);
  });

  test('the fast leg is reminded of its own answers, which it would otherwise forget', async () => {
    let seen = null;
    await brain({ agent: fakeAgent(), runFast: fast({ said: 'Rojo.' }) }).answer(ask('color?'));
    await brain({
      agent: fakeAgent(),
      runFast: async (context, memory) => {
        seen = structuredClone(memory.spoken);
        return { said: 'Porque me gusta.', escalate: false };
      },
    }).answer(ask('y por qué?'));

    assert.deepEqual(seen, [{ question: 'color?', answer: 'Rojo.' }]);
  });

  test('what either leg remembers stays bounded', async () => {
    for (let i = 0; i < 30; i += 1) {
      await brain({ agent: fakeAgent(), runFast: fast({ said: `answer ${i}` }) }).answer(ask(`q${i}`));
    }
    let seen = null;
    await brain({
      agent: fakeAgent(),
      runFast: async (_c, memory) => {
        seen = structuredClone(memory.spoken);
        return { said: 'x', escalate: false };
      },
    }).answer(ask('last'));
    assert.ok(seen.length <= 6, `kept ${seen.length}`);
  });
});

describe('the one free routing rule', () => {
  beforeEach(resetCascade);

  test('after a turn that used a tool, the next goes straight to the agent', async () => {
    // A follow-up to a tool answer nearly always refers to what the tool
    // returned, which only the agent has. Asking the fast leg to try is a
    // round trip that can only end in handing over.
    const agent = fakeAgent({ tools: ['search_web'] });
    await brain({ agent, runFast: fast({ escalate: true, reason: 'search' }) }).answer(ask('who won?'));

    let fastRan = false;
    const b = brain({
      agent: fakeAgent(),
      runFast: async () => {
        fastRan = true;
        return { said: '', escalate: false };
      },
    });
    await b.answer(ask('and by how much?'));

    assert.equal(fastRan, false, 'must not have tried the fast leg');
    assert.equal(b.escalated, true);
  });

  test('an agent turn that used no tools does not make the next one sticky', async () => {
    const agent = fakeAgent({ tools: [] });
    await brain({ agent, runFast: fast({ escalate: true, reason: 'unsure' }) }).answer(ask('q'));

    let fastRan = false;
    await brain({
      agent: fakeAgent(),
      runFast: async () => {
        fastRan = true;
        return { said: 'quick', escalate: false };
      },
    }).answer(ask('another'));

    assert.equal(fastRan, true);
  });

  test('a channel forgets its routing memory when told to', async () => {
    const agent = fakeAgent({ tools: ['x'] });
    await brain({ agent, runFast: fast({ escalate: true, reason: 'r' }) }).answer(ask('q'));
    resetCascade();

    let fastRan = false;
    await brain({
      agent: fakeAgent(),
      runFast: async () => {
        fastRan = true;
        return { said: 'quick', escalate: false };
      },
    }).answer(ask('after the session ended'));

    assert.equal(fastRan, true);
  });
});

describe('not two fillers in a row', () => {
  beforeEach(resetCascade);

  test('the canned clip is suppressed when the fast leg already spoke', async () => {
    // The agent does not know anything has been said yet, so its first tool
    // call asks for the stock "dame un segundo" — on top of the line the fast
    // leg just said. The one already spoken is better: same voice, right
    // language, about this question.
    const agent = {
      label: 'a',
      async answer(context, handlers) {
        handlers.onSearchStart?.();
        return 'answer';
      },
    };
    let filled = 0;
    await brain({ agent, runFast: fast({ said: 'Un segundo.', escalate: true, reason: 'r' }) })
      .answer(ask('q'), { onSearchStart: () => { filled += 1; } });
    assert.equal(filled, 0);
  });

  test('but it still fires when the fast leg said nothing', async () => {
    const agent = {
      label: 'a',
      async answer(context, handlers) {
        handlers.onSearchStart?.();
        return 'answer';
      },
    };
    let filled = 0;
    await brain({ agent, runFast: fast({ escalate: true, reason: 'r' }) })
      .answer(ask('q'), { onSearchStart: () => { filled += 1; } });
    assert.equal(filled, 1);
  });
});
