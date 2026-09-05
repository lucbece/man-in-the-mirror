/**
 * Short "hang on" clips, spoken while the agent is off searching the web.
 *
 * The point is to occupy a silence that already exists, not to add one. Two
 * things make that work:
 *
 *   1. They're **pre-rendered**. Synthesising one on demand would cost as much
 *      as the wait it's meant to cover, which is worse than saying nothing.
 *   2. They only play when a search **actually starts**. The model decides that
 *      mid-request, and streaming tells us at ~0.3s — early enough to be useful,
 *      and specific enough that questions answered from memory stay instant.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { config } from '../config.js';
import { DATA_DIR } from '../paths.js';
import { createTts } from './tts.js';

/**
 * Rendered clips are cached on disk, not just in memory.
 *
 * Six short clips cost about eleven seconds of synthesis and real money. Doing
 * that on every restart during development is pure waste, and they never
 * change.
 */
const CACHE_DIR = path.join(DATA_DIR, 'fillers');

function cachePath(line, voice) {
  const key = crypto.createHash('sha1').update(`${voice}:${line}`).digest('hex').slice(0, 16);
  return path.join(CACHE_DIR, `${key}.opus`);
}

/** Which voice the cached clips belong to, so a provider switch re-renders. */
function currentVoiceKey() {
  return config.get('ttsProvider') === 'local'
    ? `local:${config.get('ttsLocalVoice')}`
    : `openai:${config.get('ttsVoice')}`;
}

/**
 * Kept short on purpose: a search takes about a second and a half, so anything
 * longer would still be talking when the answer is ready.
 */
const LINES = {
  es: ['Dame un segundo.', 'Ahí busco.', 'Esperá que fijo.'],
  en: ['Give me a second.', 'Let me check.', 'One sec.'],
};

/**
 * For when it's still not back, several seconds after the first "hang on".
 *
 * Deliberately *not* said up front. Warning about a long wait before knowing
 * there is one gets it wrong in both directions: most tool calls come back
 * quickly, so the warning is usually a lie, and a bot that opens every answer
 * apologising for its speed is worse than one that occasionally makes you
 * wait. Saying it only once the wait is real is both honest and how a person
 * behaves — you say "hold on", and if it drags, you say "still looking".
 *
 * Longer than the first set, because by now buying time is the entire job.
 */
const WAITING_LINES = {
  es: ['Perdón, sigo buscando esto, dame un toque más.', 'Ahí lo tengo, aguantame un segundo más.'],
  en: ["Sorry, still digging, give me a moment.", "Nearly there, hang on a second."],
};

/**
 * The shortest thing that says "heard you": played once, the moment a tool
 * that will speak has started and nothing has been said yet, so the seconds
 * the tool takes are not silence after a question. Not on a timer: a timer
 * cannot know the turn will end in a silent music command.
 */
const ACK_LINES = {
  es: ['Mmm.', 'A ver.'],
  en: ['Hmm.', 'Let me see.'],
};

/** Rendered audio, keyed by the exact line. Survives for the process lifetime. */
const cache = new Map();

const lastIndex = { first: -1, waiting: -1, ack: -1 };
let cachedVoice = null;

/** Rotate rather than repeat — the same clip every time sounds like a recording. */
function pickLine(lang, set) {
  const table = set === 'waiting' ? WAITING_LINES : set === 'ack' ? ACK_LINES : LINES;
  const lines = table[lang] ?? table.es;
  lastIndex[set] = (lastIndex[set] + 1) % lines.length;
  return lines[lastIndex[set]];
}

/**
 * Render every line up front so the first search doesn't pay for it.
 * Failures are not fatal — a missing filler just means a quiet pause.
 */
export async function warmFillers() {
  if (!config.get('openaiApiKey')) return { rendered: 0, skipped: 'no API key' };

  let tts;
  try {
    tts = createTts();
  } catch {
    return { rendered: 0, skipped: 'no TTS provider' };
  }

  const voice = currentVoiceKey();
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // A filler in a different voice from the answer sounds like a second person
  // interrupting, so the cache is keyed by voice and re-rendered on a switch.
  if (cachedVoice !== null && cachedVoice !== voice) cache.clear();
  cachedVoice = voice;

  let rendered = 0;
  let reused = 0;

  for (const line of [...LINES.es, ...LINES.en, ...WAITING_LINES.es, ...WAITING_LINES.en, ...ACK_LINES.es, ...ACK_LINES.en]) {
    if (cache.has(line)) continue;

    const file = cachePath(line, voice);
    try {
      cache.set(line, fs.readFileSync(file));
      reused += 1;
      continue;
    } catch {
      /* not cached yet */
    }

    try {
      const audio = await tts.synthesize(line);
      fs.writeFileSync(file, audio);
      cache.set(line, audio);
      rendered += 1;
    } catch (err) {
      console.warn(`[filler] could not render "${line}": ${err.message}`);
    }
  }

  return { rendered, reused, cached: cache.size };
}

/**
 * Audio for a filler, or null if none is ready.
 *
 * Never synthesises on the spot: if it isn't cached, staying quiet is better
 * than making the wait longer to announce the wait.
 */
export function takeFiller(lang = 'es', set = 'first') {
  const line = pickLine(lang, set);
  const audio = cache.get(line);
  return audio ? { line, audio } : null;
}

/**
 * Common Spanish words, written without accents.
 *
 * Accents are stripped before comparing because JavaScript's `\b` does not
 * treat "é" as a word character — `/\bqué\b/` silently never matches, which is
 * exactly how this started classifying Spanish as English.
 */
const SPANISH_WORDS = new Set([
  'que', 'como', 'donde', 'cual', 'quien', 'por', 'para', 'pero', 'porque',
  'esta', 'estas', 'esto', 'eso', 'hola', 'gracias', 'vos', 'ustedes', 'aca',
  'del', 'los', 'las', 'una', 'con', 'muy', 'mas', 'todo', 'nada', 'algo',
  'hoy', 'manana', 'ahora', 'opinas', 'decime', 'sabes', 'puede', 'hacer',
  // The words a sentence is actually made of. Without these, "espejo, la
  // concha de tu madre" and "al fin y al cabo" were English — none of their
  // words was on the list — and everything keyed on the language (the filler
  // clip, the leaked-reasoning guard) quietly ran in the wrong mode. Words
  // English also uses ('no', 'a', 'me') are left out on purpose.
  'el', 'la', 'de', 'y', 'al', 'tu', 'te', 'mi', 'un', 'lo', 'le', 'se',
  'es', 'en', 'si', 'ya', 'sos', 'soy', 'che', 'dale', 'bien', 'bueno',
  'cuando', 'tambien', 'siempre', 'ahi', 'alla', 'mucho', 'quiero', 'podes',
  'pone', 'poneme', 'cancion', 'tema', 'fin', 'cabo', 'madre', 'hermana',
]);

/** Rough guess at which language the person is speaking. */
export function guessLanguage(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const hits = words.filter((w) => SPANISH_WORDS.has(w)).length;
  return hits > 0 ? 'es' : 'en';
}

export { LINES, WAITING_LINES, ACK_LINES };
