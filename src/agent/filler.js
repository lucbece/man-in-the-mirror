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
    // Model and rate included: a filler rendered by the other model, or at the
    // other pace, sounds like a second person cutting in.
    : `openai:${config.get('ttsVoice')}:${config.get('ttsModel')}:${config.get('ttsSpeed')}`;
}

/**
 * Kept short on purpose: a search takes about a second and a half, so anything
 * longer would still be talking when the answer is ready.
 */
const LINES = {
  es: ['Dame un segundo.', 'Ahí busco.', 'Esperá que fijo.'],
  en: ['Give me a second.', 'Let me check.', 'One sec.'],
  pt: ['Peraí um segundo.', 'Já vou ver.', 'Só um instante.'],
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
  pt: ['Desculpa, ainda tô procurando isso.', 'Já tá quase, mais um segundinho.'],
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
  pt: ['Ahn.', 'Deixa eu ver.'],
};

/** Rendered audio, keyed by the exact line. Survives for the process lifetime. */
const cache = new Map();

const lastIndex = { first: -1, waiting: -1, ack: -1 };
let cachedVoice = null;

/**
 * Rotate rather than repeat — the same clip every time sounds like a recording.
 *
 * No fallback to Spanish: a language with no recorded lines (German, Italian,
 * French, or none guessed at all) gets no filler rather than a wrong one.
 * `takeFiller` turns that into `null`, which every caller already handles.
 */
function pickLine(lang, set) {
  const table = set === 'waiting' ? WAITING_LINES : set === 'ack' ? ACK_LINES : LINES;
  const lines = table[lang];
  if (!lines || lines.length === 0) return undefined;
  lastIndex[set] = (lastIndex[set] + 1) % lines.length;
  return lines[lastIndex[set]];
}

/**
 * Render every line up front so the first search doesn't pay for it.
 * Failures are not fatal — a missing filler just means a quiet pause.
 */
export async function warmFillers() {
  // The key gate is for the API voice only: Piper renders on this machine,
  // and without this exception a local install had an empty clip cache for
  // the life of the process, so every tool call was unbroken silence.
  if (config.get('ttsProvider') !== 'local' && !config.get('openaiApiKey')) {
    return { rendered: 0, skipped: 'no API key' };
  }

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

  for (const line of [
    ...LINES.es, ...LINES.en, ...LINES.pt,
    ...WAITING_LINES.es, ...WAITING_LINES.en, ...WAITING_LINES.pt,
    ...ACK_LINES.es, ...ACK_LINES.en, ...ACK_LINES.pt,
  ]) {
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
export function takeFiller(lang = null, set = 'first') {
  const line = pickLine(lang, set);
  if (!line) return null;
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

/**
 * Common English words. Spanish overwhelmingly dominates the rooms this bot
 * sits in, so this list exists mostly so English text doesn't fall through to
 * `null` — see `guessLanguage` below.
 */
const ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'you', 'your',
  'i', 'my', 'we', 'they', 'he', 'she', 'him', 'her', 'them', 'what', 'how',
  'do', 'does', 'can', 'this', 'that', 'these', 'those', 'with', 'for', 'and',
  'not', 'it', 'its', 'of', 'in', 'on', 'at', 'to', 'but', 'or', 'so', 'just',
  'here', 'there', 'when', 'where', 'why', 'who', 'which', 'yes', 'no',
  'please', 'thanks', 'hello', 'now', 'then', 'very', 'all',
]);

/**
 * Common Brazilian Portuguese words, written without accents (see the note on
 * `SPANISH_WORDS` above — the same `\b` problem applies here).
 *
 * Several of these spellings are shared with Spanish once accents are gone
 * ("de", "que", "para", "esta"): they still count for both languages, and
 * `guessLanguage` breaks the tie in Spanish's favour, since that's what this
 * bot's rooms mostly speak. The words that are actually Portuguese-specific
 * ("nao", "voce", "isso", "muito", "obrigado", "tambem") are what carry a
 * Portuguese sentence past that tie.
 */
const PORTUGUESE_WORDS = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'em', 'no', 'na',
  'por', 'para', 'com', 'sem', 'sobre', 'que', 'quem', 'onde', 'quando',
  'como', 'qual', 'quanto', 'nao', 'sim', 'muito', 'tambem', 'entao', 'aqui',
  'la', 'isso', 'obrigado', 'voce', 'voces', 'eu', 'tu', 'ele', 'ela', 'meu',
  'minha', 'seu', 'esta', 'estao', 'ser', 'estar', 'tem', 'vai', 'fazer',
  'bem', 'ja', 'mais', 'tudo', 'nada', 'hoje', 'agora', 'depois',
]);

/** Common Italian words, accent-stripped. */
const ITALIAN_WORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'da', 'in',
  'con', 'su', 'per', 'tra', 'fra', 'che', 'chi', 'dove', 'quando', 'come',
  'quale', 'quanto', 'non', 'si', 'no', 'molto', 'anche', 'allora', 'qui',
  'qua', 'li', 'questo', 'questa', 'quello', 'grazie', 'ciao', 'io', 'tu',
  'lui', 'lei', 'noi', 'voi', 'loro', 'mio', 'tua', 'suo', 'sono', 'hanno',
  'fare', 'bene', 'gia', 'piu', 'tutto', 'niente', 'oggi', 'adesso', 'dopo',
]);

/** Common French words, accent-stripped. */
const FRENCH_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'en', 'dans', 'sur',
  'avec', 'sans', 'pour', 'par', 'que', 'qui', 'quoi', 'ou', 'quand',
  'comment', 'pourquoi', 'combien', 'ne', 'pas', 'non', 'oui', 'tres',
  'aussi', 'alors', 'ici', 'cela', 'ca', 'merci', 'bonjour', 'je', 'tu', 'il',
  'elle', 'nous', 'vous', 'ils', 'elles', 'mon', 'ma', 'ton', 'sa', 'son',
  'est', 'sont', 'etre', 'avoir', 'faire', 'bien', 'deja', 'plus', 'tout',
  'rien', 'maintenant', 'apres',
]);

/** Common German words, accent-stripped ("für" -> "fur", "schön" -> "schon"). */
const GERMAN_WORDS = new Set([
  'der', 'die', 'das', 'ich', 'du', 'er', 'sie', 'wir', 'ihr', 'und', 'oder',
  'nicht', 'kein', 'ist', 'sind', 'war', 'haben', 'sein', 'werden', 'mit',
  'von', 'zu', 'in', 'auf', 'fur', 'auch', 'aber', 'dass', 'wenn', 'wie',
  'was', 'wer', 'wo', 'warum', 'hier', 'da', 'jetzt', 'dann', 'sehr', 'schon',
  'noch', 'nur', 'mehr', 'alle', 'nichts', 'etwas', 'heute', 'bitte', 'danke',
  'ja', 'nein',
]);

/**
 * Which language wins when two score the same. Spanish first: this bot's
 * rooms speak mostly Rioplatense Spanish, and Spanish/Portuguese share enough
 * spelling (once accents are gone) that a short, ambiguous sentence should
 * read as the language actually spoken here rather than its neighbour.
 */
const LANGUAGE_PRIORITY = ['es', 'en', 'pt', 'it', 'fr', 'de'];

const WORD_LISTS = {
  es: SPANISH_WORDS,
  en: ENGLISH_WORDS,
  pt: PORTUGUESE_WORDS,
  it: ITALIAN_WORDS,
  fr: FRENCH_WORDS,
  de: GERMAN_WORDS,
};

/**
 * Rough guess at which language the person is speaking.
 *
 * Scores every language by how many of its function words appear in the
 * text and returns the top one — `null` when nothing matched at all, rather
 * than defaulting to a language nobody spoke. Every caller already treats
 * `null` (and any language with no filler lines or leaked-reasoning rule) as
 * "unknown", so guessing wrong here used to be worse than admitting it.
 */
export function guessLanguage(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const scores = {};
  for (const [lang, list] of Object.entries(WORD_LISTS)) {
    scores[lang] = words.filter((w) => list.has(w)).length;
  }

  const best = Math.max(...Object.values(scores));
  if (best === 0) return null;

  return LANGUAGE_PRIORITY.find((lang) => scores[lang] === best);
}

export { LINES, WAITING_LINES, ACK_LINES };
