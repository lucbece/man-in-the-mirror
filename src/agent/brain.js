/**
 * Turns a transcript plus a question into something worth saying out loud.
 *
 * Provider-agnostic on purpose — people bring their own key. Claude is the
 * default; OpenAI is here because anyone using the cloud transcription route
 * already has that key, so it's the no-extra-account path.
 */
import Anthropic from '@anthropic-ai/sdk';

import { config } from '../config.js';

/**
 * Hard ceiling on what gets spoken, in characters.
 *
 * Speech runs at roughly 2.5 words a second, so 300 characters is about twenty
 * seconds — already long for a voice channel. The earlier 420 let a four
 * sentence weather report through that took four seconds just to synthesise.
 * The prompt asks for brevity; this is the backstop for when it doesn't.
 */
const MAX_SPOKEN_CHARS = 300;

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
- One to three short sentences. Never more, no matter how much there is to say. Anything longer gets cut off mid-word before it reaches the channel.
- Answer the question that was asked and stop. No extra context, no statistics nobody asked for, no offering to help further.
- Plain spoken language only. No markdown, no bullet points, no headings, no code, no URLs. Write numbers as words.
- ALWAYS reply in the same language the person just spoke. If they spoke Spanish, reply in Spanish. This group switches between Spanish and English mid-conversation; follow the person who addressed you, never default to English.
- You are a friend in the call, not an assistant. Skip "Great question!", skip offering follow-ups, skip restating what was asked.
- If you don't know and can't find out, take one short sentence to say so. Do not speculate at length.
- Never read out sources, citations, domain names or links. Say the fact, not where it came from — nobody wants to hear a URL spelled out.
- If your name came up but nobody was actually asking you anything, say nothing of substance — a few words acknowledging it is plenty.
- The transcript comes from automatic speech recognition and will contain errors. If a word looks garbled, work with the likely meaning rather than quoting it back.
- Do not include internal or system XML tags in your response.`;

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

class ClaudeBrain {
  constructor({ apiKey, model, webSearch }) {
    if (!apiKey) throw new BrainError('No Anthropic API key configured.');
    this.client = new Anthropic({ apiKey });
    this.model = model || 'claude-opus-5';
    this.webSearch = webSearch;
  }

  get label() {
    return `Anthropic ${this.model}${this.webSearch ? ' (web)' : ''}`;
  }

  async answer(context) {
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      // Low effort keeps latency down; a voice reply that lands four seconds
      // late has already lost the moment.
      output_config: { effort: 'low' },
      // Anthropic runs this one itself — no client-side tool loop to write.
      // Capped low because each search costs a second or two, and this is a
      // conversation, not research.
      ...(this.webSearch
        ? { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }] }
        : {}),
      // If a safety classifier declines, fall back rather than going silent.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content: buildUserMessage(context) }],
    });

    if (response.stop_reason === 'refusal') {
      throw new BrainError("I'd rather not answer that one.");
    }

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
  constructor({ apiKey, model, webSearch }) {
    if (!apiKey) throw new BrainError('No OpenAI API key configured.');
    this.apiKey = apiKey;
    this.webSearch = webSearch;
    this.model = model || DEFAULT_MODEL;
  }

  get label() {
    return `OpenAI ${this.model}${this.webSearch ? ' (web)' : ''}`;
  }

  async answer(context) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        instructions: SYSTEM_PROMPT,
        input: buildUserMessage(context),
        ...(this.webSearch ? { tools: [{ type: 'web_search' }] } : {}),
        max_output_tokens: 400,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new BrainError(`OpenAI returned ${res.status}: ${detail.slice(0, 200)}`);
    }

    const json = await res.json();
    // Tool calls appear as their own output items; only the assistant's text
    // is meant to be spoken.
    return (json.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((block) => block.type === 'output_text')
      .map((block) => block.text)
      .join(' ')
      .trim();
  }
}

export function createBrain() {
  const provider = config.get('brainProvider');
  const model = config.get('brainModel');

  if (provider === 'openai') {
    return new OpenAiBrain({
      apiKey: config.get('openaiApiKey'),
      model,
      webSearch: config.get('webSearch'),
    });
  }
  return new ClaudeBrain({
    apiKey: config.get('anthropicApiKey'),
    model,
    webSearch: config.get('webSearch'),
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
  return `${cut.trimEnd()}…`;
}

export { BrainError, MAX_SPOKEN_CHARS, SYSTEM_PROMPT };
