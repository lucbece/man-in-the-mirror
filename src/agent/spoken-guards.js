/**
 * Things the model writes that must never be read out loud.
 *
 * Everything the model produces is spoken into a room. It has no notepad, no
 * aside, no margin — so anything it writes *about* answering gets said, in its
 * own voice, to five people who did not ask.
 *
 * Each guard here exists because a prompt asking for the same thing did not
 * hold. That is the pattern worth naming: "do not say X" is reliable enough
 * for a preference and not reliable enough for a rule, and these are rules.
 */
import { guessLanguage } from './filler.js';

/** `(reproduciendo)`, `*plays music*`, `[silencio]` — written, never spoken. */
export function isStageDirection(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;
  return (
    (trimmed.startsWith('(') && trimmed.endsWith(')')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('*') && trimmed.endsWith('*'))
  );
}

/**
 * Strip an opening aside, keeping whatever follows it.
 *
 * `isStageDirection` only catches a line that is *entirely* an aside, and the
 * one heard in a real call was "(silence) No real question here", which is an
 * aside with a sentence stapled to it. One in the middle usually belongs —
 * "es de Rada (el uruguayo)" — so only the leading one goes.
 */
export function withoutOpeningAside(text) {
  return String(text ?? '').replace(/^\s*[([*][^)\]*]{0,40}[)\]*]\s*/, '');
}

/** Function words, which are what a language leaves behind everywhere. */
const ENGLISH = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'at', 'for', 'with', 'that', 'this', 'these', 'those', 'it', 'its',
  'they', 'their', 'them', 'there', 'here', 'what', 'which', 'who', 'not',
  'no', 'and', 'or', 'but', 'so', 'just', 'like', 'about', 'something',
  'anything', 'nothing', 'actual', 'actually', 'really', 'still', 'yet',
  'seems', 'looks', 'said', 'says', 'asking', 'asked', 'answer', 'respond',
  'question', 'i', 'im', 'ill', 'ive', 'me', 'my', 'you', 'your', 'dont',
  'doesnt', 'isnt', 'hasnt', 'havent', 'theyre', 'thats', 'wasnt',
]);

const SPANISH = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'que',
  'y', 'o', 'pero', 'con', 'sin', 'por', 'para', 'en', 'es', 'son', 'era',
  'esta', 'este', 'esto', 'eso', 'ese', 'esa', 'yo', 'vos', 'tu', 'te', 'me',
  'se', 'lo', 'le', 'no', 'si', 'ya', 'ahi', 'aca', 'como', 'cuando', 'donde',
  'porque', 'che', 'dale', 'boludo', 'nada', 'algo', 'mas', 'muy', 'bien',
]);

const words = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * An answer in English to a question asked in Spanish.
 *
 * Not a language-policing rule — a leak detector. Three times now the model
 * has narrated its deliberation out loud, and every time it did so in English
 * inside a Spanish conversation: "I don't see an actual question here — vero
 * just said '4. Mueh'". Reasoning comes out in the model's own language, and
 * the reply is supposed to be in the speaker's, so the mismatch is the
 * cheapest reliable signal there is that this text was never meant to be said.
 *
 * Deliberately conservative. It needs a sentence long enough to judge, clear
 * English evidence, and effectively no Spanish — so an English song title
 * inside a Spanish sentence, or a short "dale", never trips it. A question
 * actually asked in English is left alone entirely, because then an English
 * answer is the right one.
 */
/**
 * Sentences a model writes about answering, in either language. They have no
 * place in a reply whatever the room speaks, so they are caught on their own,
 * before any language arithmetic. The fifth leak (2026-09-04) was a whole
 * paragraph of them: "I'm only hearing '¡No!' without a question directed at
 * me... I'll stay quiet and let the chat continue."
 */
const DELIBERATION = [
  /\b(i'?ll|i will|i should|i'?d better) (stay|remain|keep) (quiet|silent)\b/i,
  /\b(not|no|isn'?t|is not) (a )?(question|request) (directed|addressed) (at|to) me\b/i,
  /\bnot asking me (anything|for anything)\b/i,
  /\b(let|letting) the (chat|conversation) (continue|go on|flow)\b/i,
  /\bi'?m only hearing\b/i,
  /\bi (don'?t|do not) see an? (actual )?question\b/i,
  /\b(me quedo|voy a quedarme|mejor me quedo) (callad[oa]|en silencio)\b/i,
  /\bno (hay|es) (una )?pregunta (dirigida|para) (a )?m[ií]\b/i,
  /\bno me (est[aá]n?|esta) (preguntando|pidiendo) nada\b/i,
];

const FEW_WORDS = 3;

export function looksLikeLeakedReasoning(text, question, { room } = {}) {
  if (DELIBERATION.some((pattern) => pattern.test(String(text ?? '')))) return true;

  // A question of one or two words cannot say what language the room speaks
  // ("¡No!" is both), so the caller's reading of the room decides instead.
  // Without one, a short question is taken at face value, as before.
  const asked = words(question);
  const language = asked.length < FEW_WORDS && room ? room : guessLanguage(question);
  if (language !== 'es') return false;

  const said = words(text);
  if (said.length < 6) return false; // too short to tell, and too short to be a monologue

  const english = said.filter((w) => ENGLISH.has(w)).length;
  const spanish = said.filter((w) => SPANISH.has(w)).length;
  return english >= 3 && english > spanish * 2;
}
