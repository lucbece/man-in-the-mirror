import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AgentError } from '../src/agent/agent-brain.js';
import { OpenAiAgentSession } from '../src/agent/openai-agent.js';

/**
 * The OpenAI agent session, against an injected `fetch`.
 *
 * Everything worth testing here is how this class *reads* the Responses API
 * and what it does between requests: when a sentence is complete enough to
 * speak, that the call's memory is chained by `previous_response_id`, that a
 * function call reaches the right MCP tool and comes back as a
 * `function_call_output`, and that a wedged or runaway turn ends rather than
 * running forever. Against the real API that would be testing OpenAI; against
 * a fake stream it is testing us. Nothing here touches the network.
 */

/** A `fetch` Response streaming the given Responses-API events as SSE. */
function sseResponse(events, { status = 200 } = {}) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status });
}

const textDelta = (delta) => ({ type: 'response.output_text.delta', delta });
const functionCall = (name, args, callId = 'call_1') => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
});
const completed = (id, usage = { input_tokens: 0, output_tokens: 0 }) => ({
  type: 'response.completed',
  response: { id, usage },
});

/** An MCP surface with one tool, recording what it was asked to run. */
function fakeMcp({ run = async () => 'the tool said so' } = {}) {
  const calls = [];
  return {
    calls,
    closed: 0,
    serverNames: ['bot'],
    listTools: () => [
      {
        server: 'bot',
        name: 'set_reminder',
        toolName: 'bot__set_reminder',
        description: 'sets a reminder',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
    ],
    resolve: (toolName) => (toolName === 'bot__set_reminder' ? { server: 'bot', name: 'set_reminder' } : null),
    async callTool(server, name, args) {
      calls.push({ server, name, args });
      return run(args);
    },
    async close() {
      this.closed += 1;
    },
  };
}

/** A session whose every request is answered by `respond(body, n)`. */
function session(respond, { mcp = fakeMcp(), ...opts } = {}) {
  const sent = [];
  const s = new OpenAiAgentSession({
    guildId: 'g1',
    model: 'gpt-4.1',
    apiKey: 'sk-test',
    instructions: 'You are Mirror.',
    mcp,
    toolNames: ['bot'],
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body });
      return respond(body, sent.length - 1);
    },
    ...opts,
  });
  return { s, sent, mcp };
}

describe('a plain answer', () => {
  test('streams sentences, returns what was said, and counts the tokens', async (t) => {
    const { s, sent } = session(() =>
      sseResponse([
        textDelta('Me parece una buena idea, la verdad. '),
        textDelta('Aunque depende del server.'),
        completed('resp_1', { input_tokens: 1000, output_tokens: 500 }),
      ]),
    );
    t.after(() => s.end());

    const spoken = [];
    const text = await s.ask('¿qué opinás?', { onSentence: (c) => spoken.push(c) });

    assert.deepEqual(spoken, ['Me parece una buena idea, la verdad.', 'Aunque depende del server.']);
    assert.equal(text, 'Me parece una buena idea, la verdad. Aunque depende del server.');
    assert.equal(s.answers, 1);

    // gpt-4.1 is $2/$8 per million: 1000 in and 500 out is $0.006.
    assert.ok(Math.abs(s.spentUsd - 0.006) < 1e-9, `spent ${s.spentUsd}`);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.openai.com/v1/responses');
    assert.equal(sent[0].body.model, 'gpt-4.1');
    assert.equal(sent[0].body.instructions, 'You are Mirror.');
    assert.equal(sent[0].body.input, '¿qué opinás?');
    assert.equal(sent[0].body.store, true);
    assert.equal(sent[0].body.stream, true);
    assert.equal(sent[0].body.previous_response_id, undefined, 'a new session starts a new chain');
    assert.deepEqual(
      sent[0].body.tools.map((tool) => tool.name),
      ['bot__set_reminder'],
      'every MCP tool, and no web search unless it was asked for',
    );
  });

  test('the second question continues the first one, which is the memory of the call', async (t) => {
    let n = 0;
    const { s, sent } = session(() => {
      n += 1;
      return sseResponse([textDelta('Claro que sí, sin ninguna duda.'), completed(`resp_${n}`)]);
    });
    t.after(() => s.end());

    await s.ask('primera');
    await s.ask('segunda');

    assert.equal(sent[1].body.previous_response_id, 'resp_1');
  });

  test('web search is announced once, as a tool', async (t) => {
    const { s } = session(
      () =>
        sseResponse([
          { type: 'response.web_search_call.in_progress' },
          { type: 'response.web_search_call.in_progress' },
          textDelta('Llueve el jueves, según el pronóstico.'),
          completed('resp_1'),
        ]),
      { webSearch: true },
    );
    t.after(() => s.end());

    const tools = [];
    await s.ask('va a llover?', { onToolUse: (name) => tools.push(name) });
    assert.deepEqual(tools, ['web_search']);
  });
});

describe('using a tool', () => {
  test('runs it and comes back with a function_call_output on the same chain', async (t) => {
    const { s, sent, mcp } = session((body, n) =>
      n === 0
        ? sseResponse([
            textDelta('Dame un segundo que lo anoto.'),
            functionCall('bot__set_reminder', { message: 'sacar la basura' }),
            completed('resp_1'),
          ])
        : sseResponse([textDelta('Listo, te lo recuerdo a las ocho.'), completed('resp_2')]),
    );
    t.after(() => s.end());

    const spoken = [];
    const tools = [];
    const text = await s.ask('recordáme sacar la basura', {
      onSentence: (c) => spoken.push(c),
      onToolUse: (name) => tools.push(name),
    });

    assert.deepEqual(mcp.calls, [
      { server: 'bot', name: 'set_reminder', args: { message: 'sacar la basura' } },
    ]);
    assert.deepEqual(tools, ['bot__set_reminder']);

    // The holding line said before the tool is part of the answer: it was
    // spoken into the channel and the cascade has to remember it as such.
    assert.deepEqual(spoken, ['Dame un segundo que lo anoto.', 'Listo, te lo recuerdo a las ocho.']);
    assert.equal(text, 'Dame un segundo que lo anoto. Listo, te lo recuerdo a las ocho.');

    assert.equal(sent.length, 2);
    assert.equal(sent[1].body.previous_response_id, 'resp_1', 'continues the response that asked');
    assert.deepEqual(sent[1].body.input, [
      { type: 'function_call_output', call_id: 'call_1', output: 'the tool said so' },
    ]);
  });

  test('a tool that throws becomes an output the model can answer around', async (t) => {
    const mcp = fakeMcp({
      run: async () => {
        throw new Error('you do not have permission for that');
      },
    });
    const { s, sent } = session(
      (body, n) =>
        n === 0
          ? sseResponse([functionCall('bot__set_reminder', {}), completed('resp_1')])
          : sseResponse([textDelta('No pude, no tenés permiso para eso.'), completed('resp_2')]),
      { mcp },
    );
    t.after(() => s.end());

    const text = await s.ask('recordáme algo');
    assert.equal(text, 'No pude, no tenés permiso para eso.');
    assert.match(sent[1].body.input[0].output, /^Error: you do not have permission/);
  });

  test('a tool the model invented is told so rather than crashing the turn', async (t) => {
    const { s, sent } = session((body, n) =>
      n === 0
        ? sseResponse([functionCall('bot__fly_to_mars', {}), completed('resp_1')])
        : sseResponse([textDelta('Eso no lo puedo hacer, la verdad.'), completed('resp_2')]),
    );
    t.after(() => s.end());

    await s.ask('llevame a marte');
    assert.match(sent[1].body.input[0].output, /no tool called bot__fly_to_mars/);
  });

  test('maxTurns stops the loop and answers with what it has', async (t) => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (line) => warnings.push(line);
    t.after(() => { console.warn = warn; });

    let n = 0;
    // A model that asks for the same tool forever.
    const { s, sent } = session(
      () => {
        n += 1;
        return sseResponse([
          textDelta('Sigo mirando, dame un momento más.'),
          functionCall('bot__set_reminder', {}, `call_${n}`),
          completed(`resp_${n}`),
        ]);
      },
      { maxTurns: 3 },
    );
    t.after(() => s.end());

    const text = await s.ask('dale');

    assert.equal(sent.length, 3, 'three rounds and no more');
    assert.equal(text, 'Sigo mirando, dame un momento más. '.repeat(3).trim());
    assert.ok(warnings.some((line) => /3 tool rounds/.test(line)));
  });
});

describe('when it goes wrong', () => {
  test('a failed response throws rather than answering with nothing', async (t) => {
    const { s } = session(() =>
      sseResponse([{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }]),
    );
    t.after(() => s.end());

    await assert.rejects(() => s.ask('q'), (err) => {
      assert.ok(err instanceof AgentError);
      assert.match(err.message, /model overloaded/);
      return true;
    });
  });

  test('an HTTP error carries the status', async (t) => {
    const { s } = session(() => new Response('no such model', { status: 404 }));
    t.after(() => s.end());

    await assert.rejects(() => s.ask('q'), /OpenAI returned 404/);
  });

  test('a second question while one is in flight is refused, not queued', async (t) => {
    let release;
    const { s } = session(
      () => new Promise((resolve) => { release = () => resolve(sseResponse([textDelta('Ya está listo, tranquilo.'), completed('resp_1')])); }),
    );
    t.after(() => s.end());

    const first = s.ask('primera');
    await assert.rejects(() => s.ask('segunda'), /mid-answer/);
    release();
    await first;

    // And once it is done, the next one is taken normally.
    assert.equal(s.turn, null);
  });

  test('a closed session refuses everything', async (t) => {
    const { s } = session(() => sseResponse([completed('resp_1')]));
    t.after(() => s.end());
    s.end();

    await assert.rejects(() => s.ask('q'), /closed/);
  });
});

describe('ending it', () => {
  test('closes the MCP client and marks the session closed', async () => {
    const mcp = fakeMcp();
    const { s } = session(() => sseResponse([completed('resp_1')]), { mcp });

    s.end();
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(s.closed, true);
    assert.equal(mcp.closed, 1);
  });

  test('twice is once', async () => {
    const mcp = fakeMcp();
    const { s } = session(() => sseResponse([completed('resp_1')]), { mcp });

    s.end();
    s.end();
    await new Promise((resolve) => { setImmediate(resolve); });

    assert.equal(mcp.closed, 1);
  });
});

describe('the key', () => {
  test('a missing one fails the same way the Claude path does', () => {
    assert.throws(
      () => new OpenAiAgentSession({ guildId: 'g1', model: 'gpt-4.1', apiKey: '', mcp: fakeMcp() }),
      (err) => {
        assert.ok(err instanceof AgentError);
        assert.match(err.message, /OpenAI API key/);
        return true;
      },
    );
  });
});
