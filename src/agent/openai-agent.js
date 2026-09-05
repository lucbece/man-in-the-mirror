/**
 * The agent, on an OpenAI model.
 *
 * Same job as `AgentSession` and, from the outside, the same object: a
 * persistent thing per voice channel that remembers the call, has the bot's
 * tools and the user's MCP servers, streams sentences as it writes them, and
 * reports what it has spent. `AgentBrain`, the panel's session status, the
 * idle reaper and the cascade all treat the two identically; only `getSession`
 * knows which one it built.
 *
 * Three things are genuinely different, and they are the whole file:
 *
 * **Memory is server-side.** There is no subprocess holding a conversation, so
 * the Responses API holds it instead: every request carries
 * `previous_response_id`, and the chain starts when the session does. That is
 * cheaper than a subprocess and it is also more fragile — the chain lives at
 * OpenAI, and losing it loses the call's memory, which is why a failed turn
 * leaves the last good id in place rather than advancing to a broken one.
 *
 * **The tool loop is ours.** The Agent SDK runs the loop; here, a turn that
 * ends in function calls means running them through the MCP client and asking
 * again with the results. That is the same shape the cascade's OpenAI fast leg
 * already uses for `escalate`, one level up.
 *
 * **Cost is arithmetic.** The SDK reports dollars; this reports tokens, so the
 * price table in `models.js` turns them into the same figure.
 */
import { AgentError, TURN_TIMEOUT_MS } from './agent-brain.js';
import { withDeadline, AGENT_FIRST_BLOCK_MS } from './deadline.js';
import { costOf } from './models.js';
import { SentenceSplitter } from './sentences.js';
import { readSse } from './sse.js';
import { trace, BlockCollector } from './trace.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';

/**
 * The same ceiling the chat brain uses, with room for the model to reach a
 * tool. The spoken length is capped downstream anyway; this only stops a
 * runaway from billing for pages nobody hears.
 */
const MAX_OUTPUT_TOKENS = 600;

export class OpenAiAgentSession {
  constructor({
    signature,
    guildId,
    model,
    apiKey,
    webSearch,
    instructions,
    mcp,
    toolNames,
    maxTurns = 8,
    turn,
    fetch = globalThis.fetch,
  }) {
    if (!apiKey) throw new AgentError('The agent brain needs an OpenAI API key.');
    this.signature = signature;
    this.guildId = guildId;
    this.model = model ?? null;
    this.apiKey = apiKey;
    this.webSearch = Boolean(webSearch);
    this.instructions = instructions ?? '';
    this.maxTurns = Math.max(1, maxTurns);
    this.fetch = fetch;

    // Connecting the servers is asynchronous and building a session is not —
    // `getSession` is called from a constructor. So the client arrives as a
    // promise, started when the session is, and the first question waits on
    // it. That is the same pre-warm the Claude path gets from being started
    // as the bot joins the channel: by the time anyone asks, it is connected.
    this.mcp = null;
    this.mcpReady = Promise.resolve(mcp);
    // Nothing awaits it until the first turn, and an unawaited rejection is a
    // process-level warning. Hold it instead and let `ask` report it.
    this.mcpReady.then((client) => { this.mcp = client; }).catch(() => {});

    // From the configuration rather than from the live client, exactly as the
    // Claude session does it: what the panel shows is what was asked for.
    this.toolNames = toolNames ?? [];
    this.turn_ = turn ?? null;
    this.turn = null; // truthy while an answer is in flight, as in AgentSession
    this.closed = false;
    this.askedOnce = false;
    this.lastUsedAt = Date.now();
    this.startedAt = Date.now();
    this.spentUsd = 0;
    this.answers = 0;
    // The head of the conversation chain. Null means "start a new one", which
    // is what a fresh session is.
    this.previousResponseId = null;
  }

  /** The connected tool surface, waited for once. */
  async #tooling() {
    if (this.mcp) return this.mcp;
    try {
      this.mcp = await this.mcpReady;
    } catch (err) {
      throw new AgentError(`Could not connect the agent's tools: ${err.message}`, { cause: err });
    }
    return this.mcp;
  }

  /** Every MCP tool as a function the model may call, plus web search. */
  #tools() {
    const tools = this.mcp.listTools().map((tool) => ({
      type: 'function',
      name: tool.toolName,
      description: tool.description,
      parameters: tool.inputSchema,
      // Not strict: these schemas come from other people's MCP servers, and
      // strict mode rejects perfectly ordinary ones (a missing
      // additionalProperties, an optional field not in `required`). A tool
      // that will not load is worse than one whose arguments need checking.
      strict: false,
    }));
    if (this.webSearch) tools.push({ type: 'web_search' });
    return tools;
  }

  async #post(body, signal) {
    const res = await this.fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AgentError(`OpenAI returned ${res.status}: ${detail.slice(0, 200)}`);
    }
    return res;
  }

  /**
   * One request and its stream: the text it said, the tools it wants run, and
   * where the conversation now stands.
   */
  async #round(input, { onToolUse, onSentence, signal }) {
    // Fifteen seconds to the first output item, tried twice, then the turn
    // fails and the session stays: a lost turn costs one question, a lost
    // session costs the conversation.
    const res = await withDeadline('agent', AGENT_FIRST_BLOCK_MS, (deadline, met) =>
      this.#post(
        {
          model: this.model,
          instructions: this.instructions,
          input,
          ...(this.previousResponseId ? { previous_response_id: this.previousResponseId } : {}),
          tools: this.#tools(),
          store: true,
          stream: true,
          max_output_tokens: MAX_OUTPUT_TOKENS,
        },
        signal ? AbortSignal.any([signal, deadline]) : deadline,
      ).then(async (r) => {
        // The first item has to arrive inside the deadline too, so the stream
        // is peeked here and the event handed to the loop below.
        const events = readSse(r)[Symbol.asyncIterator]();
        const first = await events.next();
        met();
        return { events, first };
      }),
    );
    const { events, first } = res;
    const stream = (async function* () {
      if (!first.done) yield first.value;
      for (;;) {
        const next = await events.next();
        if (next.done) return;
        yield next.value;
      }
    })();

    const splitter = new SentenceSplitter();
    const block = new BlockCollector('OUTPUT', 'agent says');
    const calls = [];
    let text = '';
    let announced = false;
    let responseId = null;

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          text += event.delta ?? '';
          block.push(event.delta ?? '');
          for (const chunk of splitter.push(event.delta ?? '')) onSentence?.(chunk);
          break;
        case 'response.web_search_call.in_progress':
          if (!announced) {
            announced = true;
            onToolUse?.('web_search');
          }
          break;
        case 'response.output_item.done':
          if (event.item?.type === 'function_call') {
            calls.push({
              call_id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments ?? '{}',
            });
          }
          break;
        case 'response.completed':
          responseId = event.response?.id ?? null;
          this.spentUsd += costOf(this.model, {
            input: event.response?.usage?.input_tokens ?? 0,
            output: event.response?.usage?.output_tokens ?? 0,
          });
          break;
        case 'response.failed':
        case 'response.error':
          throw new AgentError(
            (event.response?.error?.message ?? 'OpenAI stream failed').slice(0, 200),
          );
        default:
          break;
      }
    }

    // A finished message is a finished thought. Without this flush the last
    // sentence before a tool call and the first one after it are glued
    // together — the same reason `AgentSession` flushes on every assistant
    // message rather than only at the end of the turn.
    const tail = splitter.flush();
    if (tail) onSentence?.(tail);
    block.flush();

    if (responseId) this.previousResponseId = responseId;
    return { text: text.trim(), calls };
  }

  /** Run the tools this round asked for, in order, and shape the next input. */
  async #runTools(calls, { onToolUse }) {
    const outputs = [];
    for (const call of calls) {
      const target = this.mcp.resolve(call.name);
      let args = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        /* the model wrote something that is not JSON; the tool sees no args */
      }
      trace('TOOL', call.name, args);
      onToolUse?.(call.name);

      let output;
      if (!target) {
        output = `Error: there is no tool called ${call.name}.`;
      } else {
        try {
          output = await this.mcp.callTool(target.server, target.name, args);
        } catch (err) {
          // A refusal from one of the bot's own tools is already a sentence;
          // anything else becomes one here. Either way the model gets to say
          // what it could not do rather than the turn dying.
          output = `Error: ${err.message}`;
        }
      }
      trace('TOOL ←', call.name, output);
      outputs.push({ type: 'function_call_output', call_id: call.call_id, output: output ?? '' });
    }
    return outputs;
  }

  async ask(text, { onToolUse, onSentence } = {}) {
    if (this.closed) throw new AgentError('Agent session is closed.');
    if (this.turn) throw new AgentError('Agent is mid-answer.');
    this.turn = { started: Date.now() };
    trace('INPUT', `agent turn (${this.model})`, text);
    this.lastUsedAt = Date.now();

    const startedAt = Date.now();
    const controller = new AbortController();
    let wedged = false;
    const timer = setTimeout(() => {
      // Something is wedged — a hung MCP server, a runaway loop. Same wall the
      // Claude session has, and the same conclusion: kill the session rather
      // than leave the wedge for the next question.
      wedged = true;
      controller.abort();
    }, TURN_TIMEOUT_MS);

    // Everything said this turn, holding lines included. It is what the
    // cascade remembers of the answer and what `AgentBrain` checks for
    // emptiness, so a turn that spoke before a tool must not come back blank.
    let said = '';
    const say = (chunk) => {
      said += (said ? ' ' : '') + chunk;
      onSentence?.(chunk);
    };

    let rounds = 0;
    let input = text;
    let outcome = 'success';
    try {
      await this.#tooling();
      for (;;) {
        rounds += 1;
        const { calls } = await this.#round(input, {
          onToolUse,
          onSentence: say,
          signal: controller.signal,
        });

        if (!calls.length) break;
        if (rounds >= this.maxTurns) {
          // Mirrors `error_max_turns`: whatever it managed to say stands, and
          // the loop stops rather than billing another round for a question
          // nobody is still waiting on.
          console.warn(`[agent-brain] hit ${this.maxTurns} tool rounds — answering with what it has`);
          outcome = 'max_turns';
          break;
        }
        input = await this.#runTools(calls, { onToolUse });
      }
    } catch (err) {
      if (wedged) {
        this.end();
        throw new AgentError('The agent took over two minutes — gave up on that one.', { cause: err });
      }
      throw err instanceof AgentError
        ? err
        : new AgentError(`Agent run failed: ${err.message}`.slice(0, 200), { cause: err });
    } finally {
      clearTimeout(timer);
      this.turn = null;
      this.lastUsedAt = Date.now();
    }

    this.answers += 1;
    trace(
      'TURN',
      outcome,
      `${rounds} round(s) · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ` +
        `$${this.spentUsd.toFixed(4)} so far this session`,
    );
    return said.trim();
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    this.turn = null;
    this.mcpReady.then((client) => client?.close?.()).catch(() => {});
  }
}
