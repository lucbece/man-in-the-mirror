/**
 * The notebook, written at the end of a call.
 *
 * The tools let the agent note a fact when it notices one mid-conversation,
 * but noticing costs attention it is spending on answering, and most of what
 * is worth keeping is only obvious in hindsight. So when the bot leaves the
 * channel, a small model reads the call's exchanges and writes down the two
 * or three things a friend would remember: what somebody said they like, a
 * plan, a running joke. One cheap request per call, nothing when there was
 * no conversation to speak of.
 *
 * The exchanges come from the session's own record (the last ten questions
 * and answers, kept for the panel); the transcript of the room is not sent.
 * What the bot itself said is context for what people asked, not a fact
 * about them, and the prompt says so.
 */
import { config } from '../config.js';
import { withDeadline } from './deadline.js';
import { NotebookError, MAX_NOTE_CHARS, addNote, parseNotes, serialiseNotes } from './notebook.js';

/** Fewer exchanges than this is a "qué hora es", not a conversation. */
export const MIN_EXCHANGES = 2;
/** Most a single call may add. A notebook is a notebook, not a transcript. */
export const MAX_RECAP_NOTES = 3;
const RECAP_MS = 20_000;
/** Cheap and quick; the job is extraction, not judgement. */
const OPENAI_MODEL = 'gpt-4.1-mini';
const ANTHROPIC_MODEL = 'claude-haiku-4-5';

export function recapPrompt({ exchanges, notebook }) {
  const lines = exchanges.map((e) => `${e.askedBy}: ${e.question}\nBot: ${e.answer || '(did something without speaking)'}`);
  return [
    'You keep the notebook of a voice bot that sits in a Discord call between friends. The call has just ended. Below are the questions people asked it this call and what it answered.',
    '',
    `Write down the things worth knowing next time, as a friend would remember them: what somebody said they like or cannot stand, a plan they mentioned, a running joke, who plays or does what, something that happened to them. Facts about the people and the group. Each note is one short line, under ${Math.min(160, MAX_NOTE_CHARS)} characters, in the language the person spoke, naming the person by the name shown.`,
    '',
    'Leave out: one-off requests ("play this", "what time is it"), anything the bot said as its own opinion, anything already in the notebook below, and anything sensitive (health, money, relationships, addresses, anything said in anger). When in doubt, leave it out. Most calls yield nothing, and nothing is a fine answer.',
    '',
    `Answer with a JSON array of strings only, at most ${MAX_RECAP_NOTES} notes, [] when there is nothing. No prose around it.`,
    '',
    'Already in the notebook:',
    ...(notebook.length ? notebook.map((n) => `- ${n}`) : ['- (empty)']),
    '',
    'This call:',
    ...lines,
  ].join('\n');
}

/** The model's answer as a list of notes, or [] when it is not one. */
export function parseRecap(text) {
  const raw = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n) => typeof n === 'string')
      .map((n) => n.replace(/\s+/g, ' ').trim())
      .filter((n) => n && n.length <= MAX_NOTE_CHARS)
      .slice(0, MAX_RECAP_NOTES);
  } catch {
    return [];
  }
}

/** One plain completion from whichever provider has a key. Returns text. */
export async function completeWithProvider(prompt, { signal } = {}) {
  const openai = config.get('openaiApiKey');
  if (openai) {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: OPENAI_MODEL, input: prompt, max_output_tokens: 300 }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI returned ${res.status}`);
    const json = await res.json();
    if (typeof json.output_text === 'string') return json.output_text;
    return (json.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((c) => c.text ?? '')
      .join('');
  }
  const anthropic = config.get('anthropicApiKey');
  if (anthropic) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropic, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic returned ${res.status}`);
    const json = await res.json();
    return (json.content ?? []).map((c) => c.text ?? '').join('');
  }
  throw new Error('no API key for the recap');
}

/**
 * Read the call, write the notes, return what was added.
 *
 * Duplicates and a full notebook are skipped quietly: the model was told
 * what is already there, and a note it repeats anyway is not worth a warning.
 */
export async function recapCall({ exchanges, complete = completeWithProvider, log = console.log } = {}) {
  const spoken = (exchanges ?? []).filter((e) => e && (e.question || e.answer));
  if (spoken.length < MIN_EXCHANGES) return [];

  const before = config.get('notebook');
  const prompt = recapPrompt({ exchanges: spoken, notebook: parseNotes(before) });
  const text = await withDeadline('recap', RECAP_MS, (signal) => complete(prompt, { signal }), { retries: 0 });

  let list = before;
  const added = [];
  for (const note of parseRecap(text)) {
    try {
      list = serialiseNotes(addNote(list, note));
      added.push(note);
    } catch (err) {
      if (!(err instanceof NotebookError)) throw err;
    }
  }
  if (added.length) {
    config.update({ notebook: list });
    log(`[notebook] end of call: noted ${added.map((n) => `"${n}"`).join(' · ')}`);
  } else {
    log(`[notebook] end of call: nothing worth keeping from ${spoken.length} exchange(s)`);
  }
  return added;
}
