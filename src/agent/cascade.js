/**
 * A fast model in front of the agent, deciding by trying rather than by
 * predicting.
 *
 * The agent is the reason this bot exists and also the reason it is slow: a
 * persistent session with a dozen tools reasons about whether to use them
 * before it says anything, and measured to the first spoken word that is 4.9s
 * against Haiku's 2.4s. Most of what gets said in a voice call — an opinion, a
 * joke, a fact somebody half-remembers — never needed a tool at all, and paid
 * the agent's price anyway.
 *
 * The obvious fix is a classifier that reads the question and picks a model.
 * It is the wrong fix: a classifier is itself a model call, sitting in front
 * of every question including the fast ones, so it spends latency on exactly
 * the path it is meant to make faster — and it is a second thing that can be
 * wrong.
 *
 * So the cheap model decides by attempting. It gets one tool, `escalate`, and
 * a prompt telling it to use it for anything needing a tool, live information,
 * or memory of an earlier tool result. It either answers — streaming into
 * speech immediately, with no routing cost whatsoever — or it defers.
 *
 * The arithmetic, on this project's own measurements (Haiku 2.4s to first
 * word, the agent 4.9s, one Haiku round trip ≈ 0.6s when it defers):
 *
 *     expected change ≈ p × (−2.5s) + (1 − p) × (+0.6s)
 *
 * which is a saving as soon as p, the share of turns needing no tool, passes
 * about 0.19. `answerStats()` reports the real p, which is why the measuring
 * came first.
 *
 * Three failure modes shaped the rest of this file, and the third was found in
 * use rather than in advance.
 *
 * A misrouted *action* is the bad one: the fast leg has no tools, so if it
 * takes "recordáme sacar la basura" it says "listo" and nothing is ever set —
 * the bot lying about what it did, which is worse than being slow. Hence a
 * prompt biased hard toward deferring, and no judgement call on anything
 * imperative. The second is a forked memory, handled by handing the agent what
 * was answered without it.
 *
 * The third: "no puedo" is a lie too, and the original prompt did not catch
 * it. The rule was "escalate anything asked of you as an action rather than a
 * question", so "desconectá a Marco" handed over every time — measured 8 out
 * of 8 — while "¿se puede echar a alguien del canal?" handed over none, and
 * answered that it could not do it and someone with permissions would have to.
 * Grammatically a question; in the room, someone asking for something to
 * happen. So the rule is now about the *answer* rather than the grammar: if
 * you are about to say you can't, escalate, because the other version of you
 * probably can. Measured after: 4 of 4 on the phrasings that failed, and still
 * 0 of 4 on "¿se puede aprender a programar a los 40?", which is the same
 * grammar and genuinely a question.
 */
import Anthropic from '@anthropic-ai/sdk';
import { noteTimeout, FAST_FIRST_BLOCK_MS } from './deadline.js';

import { config } from '../config.js';
import { AgentBrain, DEFAULT_AGENT_MODEL } from './agent-brain.js';
import { handleCommand } from './commands.js';
import { promptWithInstructions } from './brain.js';
import { providerFor } from './models.js';
import { SentenceSplitter } from './sentences.js';
import { readSse } from './sse.js';
import { trace } from './trace.js';

/**
 * Small and quick, and the same model already trusted with the search
 * side-call. The fast leg does no reasoning worth the name: it decides whether
 * it is out of its depth and, if not, says something conversational.
 */
// gpt-4.1 after the bench of 2026-09-05 from the server, real fast prompt and
// escalate tool, four runs: first sentence gpt-4.1 0.79 s, Haiku 1.14 s,
// Sonnet escalated three of four opinion questions and took 1.3 s to do so.
// Needs an OpenAI key; without one the leg escalates and the agent answers.
export const DEFAULT_FAST_MODEL = 'gpt-4.1';

/** Enough for the answer, short enough that it cannot ramble past the cap. */
const MAX_TOKENS = 1024;

/** How many recent question-and-answer pairs either leg is reminded of. */
const MAX_REMEMBERED = 6;

export const FAST_PROMPT_EXTRA = `

**Never write about yourself answering.** Not what you notice, not who said what, not whether something counts as a question, not what you have decided to do about it. Every word you produce is spoken aloud in a room full of people; there is no notepad. "I hear the setup to a joke, but they haven't finished asking" is thinking, and it was heard out loud. Either say the thing you would say to them, or say nothing.

You are the quick path. Another, slower version of you is available with tools — reminders, web search, the files and services this server has connected, control of the voice call, and its own memory of everything said this session. You have none of that.

The rule that catches everything else: **if your answer would be that you can't do something, escalate instead.** Not "I can't", not "you'd have to do that yourself in Discord", not "someone with permissions has to". The other version of you probably can, so those answers are almost always false coming from you. This holds however it is put — as an order ("desconectá a Marco"), as a question about you ("¿podés desconectarlo?"), or as a question about nobody in particular ("¿se puede echar a alguien del canal?"). All three are someone trying to get something done.

Call escalate, and say nothing else, whenever the answer would need any of it:
- Anything asked of you as an action — remind me, move him, disconnect her, kick someone, mute someone, put a song on, skip this one, change your voice, add that server, leave. You cannot do any of it. Saying "listo" without escalating is a lie, and saying "no puedo" is a different lie.
- Anything about your own voice being off or on — "mutéate", "modo música", "no hables mientras suena", "ya podés hablar", "volvé a hablar", "salí del modo música", "mute yourself", "you can talk again". These switch your voice off and back on, and only the other version has the switch. "Acá estoy" from you changes nothing: the voice stays off and the words are never heard.
- Anything that could have changed since you were trained: scores, weather, prices, news, what is happening today, who currently holds a job or a title.
- Anything about how this bot is configured, what it can reach, what it was told to remember, or what it is running on.
- Anything referring back to something the other version did — "what did you find", "the one you mentioned", "read that again", "how much was it".
- Anything you are not confident about. Deferring costs a second. Being confidently wrong out loud costs more.

Answer directly only when it is conversation, an opinion, a joke, an explanation, or something stable you plainly know. That is most of what gets said in a call, which is why you are here.

If you escalate you may first say one short holding line in their language — "dame un segundo", "hold on" — and nothing more. Not even that for anything about music: putting a song on, skipping, stopping. Those are carried out without a word, and your holding line would be the only sound in an exchange that was meant to be silent. That line must make no claim about what you can or cannot do: it is spoken into the channel *before* the other version has done the thing, so "no puedo poner música" becomes a lie the moment it does. Never say what you are about to do, never mention the other version of yourself, and never say the word escalate out loud.`;

export const ESCALATE_TOOL = {
  name: 'escalate',
  description:
    'Hand this question to the version of you that has tools and memory. Use it whenever the answer needs a tool, current information, or anything said earlier in the session.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Briefly, what it needs that you do not have. Not spoken aloud.',
      },
    },
    required: ['reason'],
  },
};

/**
 * The same tool, in the shape the OpenAI Responses API wants: flat rather
 * than nested under a `function` key, and `parameters` rather than
 * `input_schema`. Built from `ESCALATE_TOOL` rather than typed out again, so
 * the two can never say something different about what escalating means.
 */
export const ESCALATE_TOOL_OPENAI = {
  type: 'function',
  name: ESCALATE_TOOL.name,
  description: ESCALATE_TOOL.description,
  parameters: ESCALATE_TOOL.input_schema,
};

/**
 * What the cascade remembers between turns, per voice channel.
 *
 * Everything here exists to stop the two legs drifting into separate
 * conversations. The bot does not hear itself — Discord does not play your own
 * audio back to you, and nothing transcribes the bot — so an answer exists
 * only where it was produced. Left alone, the fast leg would forget every
 * answer it gave the moment it gave it, and the agent would never learn that
 * anything had been said in its absence.
 *
 * So `spoken` is the shared record both legs are reminded of, and `owed` is
 * the part of it the agent has not been told yet — it remembers its own turns
 * perfectly well and only needs the ones it missed. `lastUsedTools` is the one
 * routing signal that costs nothing and is worth having.
 */
/**
 * Requests that are plainly a music command, routed straight to the agent.
 *
 * The fast leg has no music tools, so it always ends up handing these over —
 * but it says something on the way, and for a command the whole point is that
 * nothing is said. Three attempts at instructing it not to produced "I can't
 * put music on", two holding lines, and a spoken "(reproduciendo)".
 *
 * A word list is a blunt instrument and this one will miss phrasings. That is
 * the right way round for it to fail: a miss leaves the old behaviour, and a
 * false positive sends an ordinary question to the agent, which answers it
 * correctly and a little slower. Neither outcome is wrong, only slower or
 * chattier.
 */
const MUSIC_COMMAND = [
  // Trailing boundaries are a lookahead rather than \b: in JavaScript \b is
  // ASCII, so there is no word boundary after "salteá" or "pará" and the
  // obvious pattern silently never matches.
  /(^|\s)(skip|saltea|salteá|salta|saltá|pasá de (tema|canción)|siguiente (tema|canción))(?=\s|$|[,.!?¡¿])/i,
  /(^|\s)(pará|para|pare|frená|frena|detené|detene|stop|corta|cortá)\s+(la\s+)?(música|musica|canción|cancion|tema)(?=\s|$|[,.!?])/i,
  /(^|\s)(poné|pone|poner|pon|reproducí|reproduci|reproducir|play)\s.{0,60}(música|musica|canción|cancion|tema|playlist|lista|disco|álbum|album)/i,
  /(^|\s)(poné|pone|pon|play)\s+\S+.{0,40}\sde\s+\S+/i,
  /(^|\s)(bajá|baja|bajame|bajale|subí|subi|subime|subile)\b.{0,30}(volumen|música|musica)/i,
  /\bvolumen\b.{0,20}(más|mas|un poco|abajo|arriba)|\b(más|mas)\s+(fuerte|bajo|alto)\b/i,
  // Lookaheads, not \b: JavaScript's \b is ASCII, so there is no boundary
  // after "sacá", "pausá" or "seguí" and the obvious pattern never fires.
  // Second time this bit; the accented imperative is the normal case here.
  /(^|\s)(saca|sacá|quita|quitá|borra|borrá|elimina|eliminá)(?=\s).{0,40}(cola|queue|lista)/i,
  /(^|\s)(pausa|pausá|pausalo|pausala|paus[aá]la|reanuda|reanudá|segu[ií]|continua|continuá)(?=\s|$|[,.!?])/i,
  /\b(disco|álbum|album)\b.{0,40}(entero|completo|todo)|\b(poné|pone|pon)\b.{0,20}\b(disco|álbum|album)\b/i,
];

const looksLikeMusicCommand = (text) => MUSIC_COMMAND.some((re) => re.test(String(text ?? '')));

/**
 * The live session for a guild, imported when first needed: voice/manager.js
 * imports the answer path, which imports this file, so a static import would
 * be a cycle resolved by luck.
 */
async function defaultGetSession(guildId) {
  const { sessionManager } = await import('../voice/manager.js');
  return sessionManager.get(guildId);
}

/**
 * Requests to switch the bot's own voice off or back on, routed the same way.
 *
 * Found in use, 2026-09-05: in music mode the room asked the bot to talk
 * again, and it kept writing into the music channel. Measured afterwards with
 * the real fast prompt and gpt-4.1: "salí del modo música" escalated 4 of 4,
 * "ya podés hablar" and "volvé a hablar" escalated 0 of 8 — the fast leg
 * answered "acá estoy" itself, which in music mode was written down, and the
 * switch it has no tool for was never touched. The prompt now names these
 * phrasings too; this list is for the ones it will still miss.
 */
const MUSIC_MODE_COMMAND = [
  /\bmodo\s+m[uú]sica\b/i,
  /\bmusic\s+mode\b/i,
  /(^|\s)(des)?mut[eé]ate(?=\s|$|[,.!?¡¿])/i,
  /\b(un)?mute\s+yourself\b/i,
  /(^|\s)(c[aá]llate|calláte)\s+(hasta|mientras|un\s+rato)(?=\s|$|[,.!?])/i,
  /(^|\s)no\s+hables\b/i,
  /\b(stay|be|keep)\s+quiet\b/i,
  /\b(ya\s+)?pod[eé]s\s+(volver\s+a\s+)?hablar\b/i,
  /\b(volv[eé]|habl[aá])\s+(a\s+hablar|de\s+nuevo)\b/i,
  /\b(talk|speak)\s+again\b|\bstop\s+being\s+quiet\b/i,
];

const looksLikeMusicModeCommand = (text) =>
  MUSIC_MODE_COMMAND.some((re) => re.test(String(text ?? '')));

/**
 * The tool's own name, said out loud.
 *
 * Heard in a real call: the fast leg spoke the word "Escalate." before handing
 * over, and the agent — handed that sentence as something already said —
 * spent its answer explaining what "escalate" had meant. The prompt forbids
 * saying it. Prompts have not been enough for this class of thing, and a tool
 * name reaching the room is never right, so it is dropped rather than asked
 * about.
 */
const LEAKED_TOOL_NAME = /^\s*escalate\b[\s.:,!¡—-]*/i;

export const withoutToolName = (text) => String(text ?? '').replace(LEAKED_TOOL_NAME, '').trim();

const state = new Map();

function stateFor(guildId) {
  if (!state.has(guildId)) state.set(guildId, { lastUsedTools: false, spoken: [], owed: [] });
  return state.get(guildId);
}

function remember(memory, question, answer, { byAgent }) {
  if (!answer) return;
  memory.spoken.push({ question, answer });
  if (memory.spoken.length > MAX_REMEMBERED) memory.spoken.shift();
  if (!byAgent) memory.owed.push({ question, answer });
}

/** Drop a channel's routing memory when its session goes. */
export function forgetCascade(guildId) {
  state.delete(guildId);
}

/** Only for tests. */
export function resetCascade() {
  state.clear();
}

export class CascadeBrain {
  /**
   * `deps` is for tests, and lets them exercise the routing without an API key
   * or a session process. The agent is built lazily for a plainer reason: in
   * cascade mode most turns never reach it, and constructing one starts the
   * session it belongs to.
   */
  constructor({ guildId, deps = {} }) {
    this.guildId = guildId ?? 'default';
    this.fastModel = config.get('fastModel') || DEFAULT_FAST_MODEL;
    this.agentModel = config.get('brainModel') || DEFAULT_AGENT_MODEL;
    this.deps = deps;
    this.agentBrain = null;
    this.escalated = false;
    this.reason = null;
  }

  get label() {
    // The agent behind the fast leg is whichever provider its model id names,
    // so the label has to read it rather than assume Claude.
    const provider = providerFor(this.agentModel) === 'openai' ? 'OpenAI' : 'Claude';
    return `${this.fastModel} in front of ${provider} agent ${this.agentModel}`;
  }

  get agent() {
    this.agentBrain ??= this.deps.agent ?? new AgentBrain({ guildId: this.guildId });
    return this.agentBrain;
  }

  async answer(context, { onSearchStart, onSentence, onToolUse } = {}) {
    const memory = stateFor(this.guildId);

    // A command that needs no model at all: skip, stop, pause, resume, the
    // volume. Carried out here, in no time, with the same note in the music
    // channel the tool writes; reported as that tool so the turn is silent.
    // Anything the matcher is unsure of, or that has nothing to act on, goes
    // on to the agent as before. First of all the routing, before the rule
    // that sends follow-ups to a tool-using turn to the agent: "poné X" is a
    // tool turn, and the "saltá" that follows it is the case this exists for.
    const getSession = this.deps.getSession ?? defaultGetSession;
    const carriedOut = await handleCommand(context, this.guildId, { getSession }).catch((err) => {
      console.warn(`[cascade] command failed, asking the agent instead: ${err.message}`);
      return null;
    });
    if (carriedOut) {
      this.escalated = false;
      this.reason = 'a music command, carried out without a model';
      trace('ROUTE', 'carried out without a model', `${carriedOut} for: "${context.question}"`);
      onToolUse?.(carriedOut);
      memory.lastUsedTools = true;
      return '';
    }

    // The one free routing signal worth having. A follow-up to a turn that
    // used a tool almost always refers to what that tool returned, which only
    // the agent has — asking the fast leg to try is a guaranteed round trip
    // wasted. Everything else is left to the model, which knows what it can't
    // do far better than any rule about the shape of a question.
    //
    // Deliberately not a rule: "no MCP servers configured means the agent has
    // nothing to offer". It always has its own tools — reminders, the call,
    // its settings — so that reasoning is simply wrong.
    if (memory.lastUsedTools) {
      this.escalated = true;
      this.reason = 'the last answer used a tool, so this may be about what it found';
      return this.#runAgent(context, memory, { onSearchStart, onSentence, onToolUse });
    }

    // A command, not a question. The fast leg cannot carry it out and cannot
    // be relied on to stay quiet about that, so it never sees it.
    if (looksLikeMusicCommand(context.question)) {
      this.escalated = true;
      this.reason = 'a music command, which the fast leg has no tools for';
      return this.#runAgent(context, memory, { onSearchStart, onSentence, onToolUse });
    }

    // Music mode: everything goes to the agent. The reason the fast leg is in
    // front — the first spoken word arriving two seconds sooner — does not
    // exist while nothing is spoken, and the one request that matters in this
    // state, "you can talk again", needs a tool only the agent has. Handed to
    // the fast leg it answered "acá estoy" in writing and the mode stayed on.
    if (context.quiet) {
      this.escalated = true;
      this.reason = 'music mode: nothing is spoken, and the way out of it is a tool';
      return this.#runAgent(context, memory, { onSearchStart, onSentence, onToolUse });
    }

    // Switching the voice off or on is a tool too, and the fast leg saying
    // "dale, me callo" changes nothing about what the room hears next.
    if (looksLikeMusicModeCommand(context.question)) {
      this.escalated = true;
      this.reason = 'a music mode switch, which the fast leg has no tools for';
      return this.#runAgent(context, memory, { onSearchStart, onSentence, onToolUse });
    }

    const runFast = this.deps.runFast ?? ((...args) => this.#runFast(...args));
    const { said, escalate, reason } = await runFast(context, memory, { onSentence });
    if (escalate) trace('ROUTE', 'escalated to agent', reason + (said ? `\n(after saying: "${said}")` : ''));
    else trace('OUTPUT', 'fast leg says', said);
    if (!escalate) {
      memory.lastUsedTools = false;
      remember(memory, context.question, said, { byAgent: false });
      return said;
    }

    this.escalated = true;
    this.reason = reason;
    console.log(`[cascade] escalating: ${reason}`);
    return this.#runAgent(
      // Whatever the fast leg already said has been spoken into the channel —
      // it cannot be taken back, so the agent continues from it rather than
      // starting again. It doubles as the filler, which is better than the
      // canned clip: it is the bot's own voice, in the right language, saying
      // something that fits the moment.
      { ...context, alreadySaid: said || null },
      memory,
      { onSearchStart, onSentence, onToolUse },
    );
  }

  async #runAgent(context, memory, handlers) {
    // Handed over once and then forgotten: the session keeps its own memory of
    // everything it is told, so repeating these next turn would be the same
    // conversation twice. Forgotten after the hand-over succeeds, not before:
    // a turn that fails would otherwise take them with it.
    const asides = memory.owed.slice();

    let usedTools = false;
    const text = await this.agent.answer(
      { ...context, asides },
      {
        ...handlers,
        // The agent has no idea anything has been said yet, so its first tool
        // call would ask for the canned "dame un segundo" clip on top of the
        // line the fast leg just spoke. Two fillers back to back is worse than
        // none, and the one already said is better — it is the bot's own
        // voice, in the right language, about this question.
        onSearchStart: context.alreadySaid ? undefined : handlers.onSearchStart,
        onToolUse: (name) => {
          usedTools = true;
          handlers.onToolUse?.(name);
        },
      },
    );
    memory.owed.splice(0, asides.length);
    memory.lastUsedTools = usedTools;
    remember(memory, context.question, text, { byAgent: true });
    return text;
  }

  /**
   * The fast leg: `{ said, escalate, reason }`.
   *
   * It reports rather than decides, so that everything about routing — what
   * happens on a deferral, what the agent is told, what is remembered — lives
   * in one method above instead of being spread across whoever set a flag.
   *
   * Dispatched by `fastModel`'s provider rather than a separate setting: a
   * room only ever has the one id to type in, and the id already says which
   * account it needs a key for.
   */
  async #runFast(context, memory, { onSentence }) {
    const provider = providerFor(this.fastModel);
    if (provider === 'anthropic') return this.#runFastAnthropic(context, memory, { onSentence });
    if (provider === 'openai') return this.#runFastOpenAI(context, memory, { onSentence });
    // Neither a known id nor a recognisable prefix. Escalating rather than
    // throwing keeps the turn alive — the agent is still Claude and can still
    // answer it — the same reasoning as every other failure in this method.
    return {
      said: '',
      escalate: true,
      reason: `don't know how to run "${this.fastModel}" as the fast model`,
    };
  }

  async #runFastAnthropic(context, memory, { onSentence }) {
    const apiKey = config.get('anthropicApiKey');
    if (!apiKey) {
      // Not an error: the agent needs the same key, so this fails loudly one
      // step later with a message about the key rather than about routing.
      return { said: '', escalate: true, reason: 'no Anthropic key for the fast model' };
    }

    const client = new Anthropic({ apiKey });
    // Five seconds to its first content block, or the agent takes the question:
    // escalation is the retry here, so the deadline itself tries only once.
    const deadline = new AbortController();
    let arrived = false;
    const firstBlock = setTimeout(() => {
      if (!arrived) {
        noteTimeout('fast');
        deadline.abort(new Error(`no content block in ${FAST_FIRST_BLOCK_MS / 1000}s`));
      }
    }, FAST_FIRST_BLOCK_MS);
    firstBlock.unref?.();
    const stream = client.messages.stream(
      {
        model: this.fastModel,
        max_tokens: MAX_TOKENS,
        system: promptWithInstructions(this.guildId, FAST_PROMPT_EXTRA),
        tools: [ESCALATE_TOOL],
        messages: [{ role: 'user', content: buildFastMessage(context, memory) }],
      },
      { signal: deadline.signal },
    );
    stream.on('streamEvent', (event) => {
      if (event?.type === 'content_block_start') {
        arrived = true;
        clearTimeout(firstBlock);
      }
    });
    trace('INPUT', `fast leg (${this.fastModel})`, buildFastMessage(context, memory));

    // Sentences go out as they complete, exactly as the chat brain does it, so
    // an answer the fast leg keeps starts speaking with no routing cost at all.
    const splitter = new SentenceSplitter();
    let said = '';
    if (onSentence) {
      stream.on('text', (delta) => {
        for (const chunk of splitter.push(delta)) {
          const clean = withoutToolName(chunk);
          if (!clean) continue; // the tool name and nothing else
          said += (said ? ' ' : '') + clean;
          onSentence(clean);
        }
      });
    }

    let response;
    try {
      response = await stream.finalMessage();
    } catch (err) {
      // A failure here must not lose the question: the agent can still answer
      // it, and would have been the only option before this file existed.
      return { said, escalate: true, reason: `the fast model failed (${err?.message ?? err})` };
    } finally {
      clearTimeout(firstBlock);
    }

    const rest = withoutToolName(splitter.flush());
    if (rest) {
      said += (said ? ' ' : '') + rest;
      onSentence?.(rest);
    }

    const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'escalate');
    return {
      said: said.trim(),
      escalate: Boolean(call),
      reason: call?.input?.reason ?? null,
    };
  }

  /**
   * Same job as `#runFastAnthropic`, over the OpenAI Responses API — the same
   * one `brain.js`'s chat mode uses, streamed the same way. `escalate` is a
   * function tool there rather than a built-in one: it arrives as a
   * `function_call` output item, complete by the time `output_item.done`
   * fires, so there is no need to accumulate its arguments delta by delta the
   * way the streamed text is.
   */
  async #runFastOpenAI(context, memory, { onSentence }) {
    const apiKey = config.get('openaiApiKey');
    if (!apiKey) {
      // Not an error, same as the Anthropic branch: the chat and agent modes
      // need the same key, so this fails loudly one step later instead.
      return { said: '', escalate: true, reason: 'no OpenAI key for the fast model' };
    }

    const fetchImpl = this.deps.fetch ?? fetch;
    const message = buildFastMessage(context, memory);
    trace('INPUT', `fast leg (${this.fastModel})`, message);

    const splitter = new SentenceSplitter();
    let said = '';
    let escalateArgs = null;

    // Same deadline as the Anthropic leg: first output item in five seconds,
    // or the agent takes the question.
    const deadline = new AbortController();
    let arrived = false;
    const firstBlock = setTimeout(() => {
      if (!arrived) {
        noteTimeout('fast');
        deadline.abort(new Error(`no content block in ${FAST_FIRST_BLOCK_MS / 1000}s`));
      }
    }, FAST_FIRST_BLOCK_MS);
    firstBlock.unref?.();

    try {
      const res = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.fastModel,
          instructions: promptWithInstructions(this.guildId, FAST_PROMPT_EXTRA),
          input: message,
          tools: [ESCALATE_TOOL_OPENAI],
          max_output_tokens: MAX_TOKENS,
          stream: true,
        }),
        signal: deadline.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenAI returned ${res.status}: ${detail.slice(0, 200)}`);
      }

      // Sentences go out as they complete, exactly as the Anthropic leg does
      // it, so an answer this leg keeps starts speaking with no routing cost.
      for await (const event of readSse(res)) {
        if (event.type === 'response.output_item.added' || event.type === 'response.output_text.delta') {
          arrived = true;
          clearTimeout(firstBlock);
        }
        switch (event.type) {
          case 'response.output_text.delta':
            if (onSentence) {
              for (const chunk of splitter.push(event.delta ?? '')) {
                const clean = withoutToolName(chunk);
                if (!clean) continue; // the tool name and nothing else
                said += (said ? ' ' : '') + clean;
                onSentence(clean);
              }
            }
            break;
          case 'response.output_item.done':
            if (event.item?.type === 'function_call' && event.item?.name === 'escalate') {
              escalateArgs = event.item.arguments ?? '{}';
            }
            break;
          case 'response.failed':
          case 'response.error':
            throw new Error(event.response?.error?.message ?? 'OpenAI stream failed');
          default:
            break;
        }
      }
    } catch (err) {
      // A failure here must not lose the question, same as the Anthropic leg.
      return { said, escalate: true, reason: `the fast model failed (${err?.message ?? err})` };
    } finally {
      clearTimeout(firstBlock);
    }

    const rest = withoutToolName(splitter.flush());
    if (rest) {
      said += (said ? ' ' : '') + rest;
      onSentence?.(rest);
    }

    if (!escalateArgs) return { said: said.trim(), escalate: false, reason: null };

    let reason = null;
    try {
      reason = JSON.parse(escalateArgs).reason ?? null;
    } catch {
      /* malformed arguments; still hand over, just without a reason */
    }
    return { said: said.trim(), escalate: true, reason };
  }
}

/**
 * The fast leg's one message.
 *
 * It has no session, so it gets the recent transcript every time. The
 * transcript is what people said; it does not contain the bot's own replies,
 * because nothing transcribes the bot. Without the second block below, "and
 * why?" asked straight after an answer would reach a model with no idea what
 * it had just said.
 */
function buildFastMessage({ transcript, question, askedBy }, memory) {
  const parts = [];
  if (transcript) {
    parts.push('Here is what has been said in the voice channel recently:', '', transcript, '');
  } else {
    parts.push("There's no recent conversation to go on.", '');
  }
  if (memory?.spoken.length) {
    parts.push('What you have already answered in this call, oldest first:', '');
    for (const { question: q, answer } of memory.spoken) {
      parts.push(`They asked: ${q}`, `You said: ${answer}`, '');
    }
  }
  parts.push(`${askedBy} is now asking you, out loud: ${question}`);
  return parts.join('\n');
}
