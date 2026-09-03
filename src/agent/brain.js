/**
 * Turns a transcript plus a question into something worth saying out loud.
 *
 * Provider-agnostic on purpose — people bring their own key. Claude is the
 * default; OpenAI is here because anyone using the cloud transcription route
 * already has that key, so it's the no-extra-account path.
 */
import Anthropic from '@anthropic-ai/sdk';

import { config } from '../config.js';
import { AgentBrain, guildNameResolver } from './agent-brain.js';
import { CascadeBrain } from './cascade.js';
import { SentenceSplitter } from './sentences.js';
import { customInstructionBlock } from './instructions.js';

/**
 * Hard ceiling on what gets spoken, in characters.
 *
 * Speech runs at roughly 2.5 words a second, so this is about twenty-five
 * seconds — the ceiling, not the target.
 *
 * Tuning this is a balance, and both ends are bad. At 420 a four-sentence
 * weather report got through and took four seconds just to synthesise. At 300,
 * paired with a "answer and stop" instruction, replies became one-liners with
 * no reasoning in them and the whole thing came across as stupid. The prompt
 * asks for two to four sentences; this is only the backstop.
 */
const MAX_SPOKEN_CHARS = 380;

/**
 * Room for the model to think *and* answer. On Claude Opus 5 thinking is on by
 * default and `max_tokens` caps thinking plus response together — setting this
 * to a "short reply" number would let reasoning eat the whole budget and
 * truncate the answer mid-word. Brevity is enforced by the prompt and the
 * truncation above, not by starving the token budget.
 */
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `You are Mirror, a participant in a Discord voice call between friends. Someone has just said your name, which is why you're being asked. You will be heard, not read — your answer is converted to speech and played into the channel.

What you're given is a transcript line containing your name somewhere in it. That whole line is what they said to you; work out what they're actually asking. Your name may be mangled by speech recognition — "espejo", "mirrow", "el mirror" are all you.

How to answer:
- Two to four sentences. Long enough to actually say something, short enough that nobody has to wait through it.
- Have a point of view and give the reason behind it. A bare verdict with no reasoning sounds thoughtless, and "it depends on your priorities" with nothing after it is worse than saying nothing.
- Cut padding, not substance: no restating the question, no listing every consideration, no statistics nobody asked for, no offering to help further. The reasoning stays; the filler goes.
- Plain spoken language only. No markdown, no bullet points, no headings, no code, no URLs. Write numbers as words.
- ALWAYS reply in the same language the person just spoke. If they spoke Spanish, reply in Spanish. This group switches between Spanish and English mid-conversation; follow the person who addressed you, never default to English.
- You are a friend in the call, not an assistant. Skip "Great question!", skip offering follow-ups, skip restating what was asked.
- If the answer could have changed since you were trained — scores, results, weather, prices, news, who currently holds a job or title, anything with "latest" or "today" or "now" in it — search for it. Do not answer those from memory: you will be confidently wrong, and stale facts said with certainty are worse than a short pause.
- If you don't know and can't find out, take one short sentence to say so. Do not speculate at length.
- Never read out sources, citations, domain names or links. Say the fact, not where it came from — nobody wants to hear a URL spelled out.
- If your name came up but nobody was actually asking you anything, answer with a word or two and stop — "qué pasó", "acá estoy", "jaja". Do not explain that there was no question in it; that explanation is longer than the answer and it gets spoken.
- The transcript comes from automatic speech recognition and will contain errors. If a word looks garbled, work with the likely meaning rather than quoting it back.
- Do not include internal or system XML tags in your response.`;

/**
 * The system prompt a brain in this guild actually sends.
 *
 * All three brains build it the same way — fixed rules, whatever that mode
 * adds, then the room's own standing instructions — and all three have to
 * render the people written into those instructions through the same
 * resolver. Rendering is what makes an instruction about someone keep working
 * after they rename themselves: the model reads the name that also labels
 * that person's lines in the transcript it is given.
 *
 * `resolve` is injectable so this can be exercised without a Discord client.
 */
export function promptWithInstructions(guildId, extra = '', resolve = guildNameResolver(guildId)) {
  return SYSTEM_PROMPT + extra + customInstructionBlock(config.get('customInstructions'), resolve);
}

class BrainError extends Error {}

function buildUserMessage({ transcript, question, askedBy }) {
  const parts = [];
  if (transcript) {
    parts.push(
      'Here is what has been said in the voice channel recently:',
      '',
      transcript,
      '',
    );
  } else {
    parts.push("There's no recent conversation to go on.", '');
  }
  parts.push(`${askedBy} is now asking you, out loud: ${question}`);
  return parts.join('\n');
}

/**
 * Sonnet rather than Opus, on measurement rather than tier.
 *
 * Same three questions, effort low, two runs each: Sonnet answered in 2.5s,
 * 3.9s and 4.2s; Opus in 2.4s, 5.1s and 4.5s — no quality gap worth the wait in
 * a live call, and Opus is markedly slower once search is involved (13s against
 * 6s). Opus 5 is one field away in the panel for anyone who wants the ceiling.
 */
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

/**
 * Not every Claude model takes every knob, and sending an unsupported one is a
 * hard 400 rather than something ignored. Found the hard way: Haiku 4.5
 * rejects `effort`, Sonnet 5 rejects `fallbacks`, and both were being sent
 * unconditionally — which broke exactly the two fast models worth using here.
 */
function claudeSupports(model) {
  return {
    // Effort tuning arrived with the 4.6 generation; Haiku has no such control.
    effort: /opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable-5|mythos-5/.test(model),
    // Server-side refusal fallbacks are Opus 5 and Fable 5 only.
    fallbacks: /opus-5|fable-5|mythos-5/.test(model),
    // Web search needs a recent enough model to have the tool at all.
    webSearch: /opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable-5|mythos-5/.test(model),
  };
}

class ClaudeBrain {
  constructor({ apiKey, model, webSearch, guildId }) {
    if (!apiKey) throw new BrainError('No Anthropic API key configured.');
    // Only ever used to look people up by id when the prompt is built.
    this.guildId = guildId ?? 'default';
    this.client = new Anthropic({ apiKey });
    this.model = model || DEFAULT_CLAUDE_MODEL;
    this.can = claudeSupports(this.model);
    this.webSearch = webSearch && this.can.webSearch;
  }

  get label() {
    return `Anthropic ${this.model}${this.webSearch ? ' (web)' : ''}`;
  }

  async answer(context, { onSearchStart, onSentence, onToolUse } = {}) {
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: promptWithInstructions(this.guildId),
      // Low effort keeps latency down; a voice reply that lands four seconds
      // late has already lost the moment. Not every model accepts it.
      ...(this.can.effort ? { output_config: { effort: 'low' } } : {}),
      // Anthropic runs this one itself — no client-side tool loop to write.
      //
      // One search, not two. Measured: at `max_uses: 2` a weather question took
      // 13s; the model also scales searches with effort, and at `medium` it
      // made six of them and took 26s. Each round trip is seconds, and this is
      // a conversation.
      ...(this.webSearch
        ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 1 }] }
        : {}),
      // If a safety classifier declines, fall back rather than going silent.
      ...(this.can.fallbacks
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {}),
      messages: [{ role: 'user', content: buildUserMessage(context) }],
    });

    let announced = false;
    stream.on('streamEvent', (event) => {
      // The server tool announces itself before any answer text exists.
      if (
        !announced &&
        event.type === 'content_block_start' &&
        event.content_block?.type === 'server_tool_use' &&
        event.content_block?.name === 'web_search'
      ) {
        announced = true;
        onToolUse?.('web_search');
        onSearchStart?.();
      }
    });

    // Hand out sentences as they complete, so the voice can start before the
    // model has finished. Roughly a second and a half earlier, measured.
    const splitter = new SentenceSplitter();
    if (onSentence) {
      stream.on('text', (delta) => {
        for (const chunk of splitter.push(delta)) onSentence(chunk);
      });
    }

    let response;
    try {
      response = await stream.finalMessage();
    } catch (err) {
      // A valid key on an unfunded account is the single most likely first-run
      // failure, and the raw message doesn't say which account to go and fix.
      const detail = err?.error?.error?.message ?? err?.message ?? '';
      if (/credit balance is too low/i.test(detail)) {
        throw new BrainError(
          'Your Anthropic account has no credit. Add some at console.anthropic.com → Plans & Billing.',
        );
      }
      if (err?.status === 401) throw new BrainError('Anthropic rejected the API key.');
      throw new BrainError(detail.slice(0, 200) || 'Anthropic request failed');
    }

    if (response.stop_reason === 'refusal') {
      throw new BrainError("I'd rather not answer that one.");
    }

    // The tail that never got its full stop still has to be said.
    const tail = splitter.flush();
    if (tail) onSentence?.(tail);

    // Server tools interleave their own blocks with the text; we only want
    // what it decided to say out loud.
    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .trim();
  }
}

/**
 * Measured, not assumed: gpt-4.1 answers in ~0.9s, gpt-4o-mini in ~1.7s, and
 * the gpt-5 reasoning models in 6-7s because they think first. In a live
 * conversation that thinking is a liability, not a feature — the moment has
 * passed by the time it speaks.
 */
const DEFAULT_MODEL = 'gpt-4.1';

/**
 * Search is a *tool* a conversational model may reach for, not a different
 * model to swap in.
 *
 * The `-search-preview` models look like an easy drop-in and behave terribly
 * here: they're tuned to answer search queries, so they largely ignore the
 * system prompt. Asked in Spanish they answered in English; asked "why are you
 * speaking English?" one explained how to change Discord's language settings;
 * and every reply came back as a four-sentence results dump. Same question
 * through gpt-4.1 with the search tool: one sentence, in Spanish, 89
 * characters.
 */
class OpenAiBrain {
  constructor({ apiKey, model, webSearch, guildId }) {
    if (!apiKey) throw new BrainError('No OpenAI API key configured.');
    this.guildId = guildId ?? 'default';
    this.apiKey = apiKey;
    this.webSearch = webSearch;
    this.model = model || DEFAULT_MODEL;
  }

  get label() {
    return `OpenAI ${this.model}${this.webSearch ? ' (web)' : ''}`;
  }

  /**
   * `onSearchStart` fires as soon as the model decides to look something up —
   * about 0.3s in, well before the answer exists. That's the only moment where
   * saying "hang on" is honest rather than a delay of its own.
   */
  async answer(context, { onSearchStart, onSentence, onToolUse } = {}) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: promptWithInstructions(this.guildId),
        input: buildUserMessage(context),
        ...(this.webSearch ? { tools: [{ type: 'web_search' }] } : {}),
        max_output_tokens: 400,
        stream: true,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BrainError(`OpenAI returned ${res.status}: ${detail.slice(0, 200)}`);
    }

    let text = '';
    let announced = false;
    const splitter = new SentenceSplitter();

    for await (const event of readSse(res)) {
      switch (event.type) {
        case 'response.web_search_call.in_progress':
          if (!announced) {
            announced = true;
            onToolUse?.('web_search');
            onSearchStart?.();
          }
          break;
        case 'response.output_text.delta':
          text += event.delta ?? '';
          if (onSentence) for (const chunk of splitter.push(event.delta)) onSentence(chunk);
          break;
        case 'response.failed':
        case 'response.error':
          throw new BrainError(event.response?.error?.message ?? 'OpenAI stream failed');
        default:
          break;
      }
    }

    const tail = splitter.flush();
    if (tail) onSentence?.(tail);

    return text.trim();
  }
}

/** Iterate an SSE body as parsed JSON events. */
async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        /* keep-alive or partial frame */
      }
    }
  }
}

export function createBrain({ guildId } = {}) {
  const provider = config.get('brainProvider');
  const model = config.get('brainModel');

  // The agent brain is Anthropic-only (it *is* a Claude session), so the
  // kind switch outranks the provider switch rather than combining with it.
  // The cascade is the agent with a fast model in front, so the same applies.
  if (config.get('brainKind') === 'cascade') {
    return new CascadeBrain({ guildId: guildId ?? 'default' });
  }
  if (config.get('brainKind') === 'agent') {
    return new AgentBrain({ guildId: guildId ?? 'default' });
  }

  if (provider === 'openai') {
    return new OpenAiBrain({
      apiKey: config.get('openaiApiKey'),
      model,
      webSearch: config.get('webSearch'),
      guildId: guildId ?? 'default',
    });
  }
  return new ClaudeBrain({
    apiKey: config.get('anthropicApiKey'),
    model,
    webSearch: config.get('webSearch'),
    guildId: guildId ?? 'default',
  });
}

/**
 * Trim to something speakable. Cuts at a sentence boundary where possible —
 * stopping mid-clause sounds like a crash, stopping after a full stop sounds
 * like a choice.
 */
export function clampForSpeech(text, limit = MAX_SPOKEN_CHARS) {
  const clean = text
    // Fenced code first — everything inside it is unspeakable.
    .replace(/```[\s\S]*?```/g, ' ')
    // Web search returns citations as "([lanacion.com.ar](https://…))". Drop
    // the whole thing, source name included — read aloud that becomes "la
    // nacion punto com punto a r", which is nobody's idea of an answer.
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
    // Any other markdown link: keep the words, drop the URL.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Bare URLs.
    .replace(/\bhttps?:\/\/\S+/gi, '')
    // Bare domains, e.g. a stray "lanacion.com.ar" left in prose.
    .replace(/\b(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|gov|edu|ar|es|mx|uk|de|fr|it|br)(?:\.[a-z]{2})?\b\/?\S*/gi, '')
    // List markers at the start of a line, before newlines collapse away.
    .replace(/^[\s]*[-*•]\s+/gm, '')
    .replace(/^[\s]*\d+[.)]\s+/gm, '')
    .replace(/[*_#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length <= limit) return clean;

  const cut = clean.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastStop > limit * 0.5) return cut.slice(0, lastStop + 1);
  // The ellipsis has to come out of the budget, not be added on top of it.
  // Returning limit + 1 characters let a reply run one past the cap on every
  // chunk, which `ask()` subtracts from a running budget — so the overshoot
  // accumulated across an answer rather than staying a rounding error.
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export { BrainError, MAX_SPOKEN_CHARS, SYSTEM_PROMPT };
