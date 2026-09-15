/**
 * Is a sentence asking something back at the person, rather than something
 * the bot actually needs answered?
 *
 * Shared between voice/session.js — where it decides whether the bot's own
 * trailing question opens a reply window — and agent/index.js — where it
 * decides whether a sentence the fast leg produced gets held back instead of
 * spoken. One predicate, so the two never drift apart on what counts as a
 * return question.
 */
import { normalise } from './wake.js';

/** Did the bot's own reply end by asking something? */
export function endsWithQuestion(text) {
  const trimmed = String(text ?? '').trim().replace(/["'»)\]]+$/, '');
  return trimmed.endsWith('?');
}

/**
 * Pull out the question an answer actually closes on, so a return question
 * tacked onto a real sentence ("Todo bien, ¿vos cómo andás?") is judged on its
 * own instead of dragging the whole answer into the match. Spanish marks
 * where a question starts with "¿" — the last one in the text is used; without
 * one (English, or a stray missing mark) the last clause is used instead.
 *
 * Also drops a trailing vocative — "¿Qué se cuenta, Fede?" is addressed to
 * Fede, not asking about someone named Fede. Detected on the punctuation and
 * capitalisation of the model's own written answer (a comma then one
 * capitalised word right before the end), not on knowing who's in the call.
 */
export function closingClause(text) {
  const trimmed = String(text ?? '').trim();
  const invertedAt = trimmed.lastIndexOf('¿');
  const clause =
    invertedAt !== -1
      ? trimmed.slice(invertedAt)
      : (trimmed.split(/[,.;:!?]+/).map((c) => c.trim()).filter(Boolean).pop() ?? trimmed);
  return clause.replace(/,\s*\p{Lu}\p{L}*\s*([?!.]*)$/u, '$1');
}

/**
 * Words that turn a question into one the bot actually needs answered, no
 * matter how much it otherwise reads like small talk — "¿Vos desde qué
 * ciudad?" and "¿Vos querés la de Rada o la de Casero?" both open with "vos"
 * but are not return questions.
 */
export const VALUE_ASKING_WORDS =
  /\b(desde|hasta|cual|cuales|cuando|donde|quien|quienes|cuanto|cuanta|cuantos|cuantas|por que|which|when|where|who|how many|how much)\b/;

/**
 * Small-talk closers and tag questions, as patterns over the normalised
 * closing clause rather than an exact list — real ones vary in wording far
 * more than a fixed set can enumerate: "¿vos qué onda?", "¿Y vos cómo vas?",
 * "¿Qué onda vos?", "¿Cómo va vos, todo en orden?" were all measured and none
 * of them match each other literally. Each pattern allows for the person's
 * own name tying it to what came before ("y …") and a trailing "vos" / "por
 * ahi" / "por alla" / "che" tacked on the end.
 */
export const RETURN_QUESTION_PATTERNS = [
  // The listener's own state: "vos", "vos qué onda", "vos cómo andás"...
  /^(y )?(vos|tu|usted|ustedes)( (que|como))?( (onda|tal|andas|venis|vas|estas|tranqui|todo bien|todo en orden))?$/,
  /^(y )?del tuyo$/,
  // The same, opener-first: "cómo va", "qué onda vos", "cómo va vos, todo en orden"...
  /^(y )?(como|que) (va|vas|andas|venis|onda|tal)( vos)?( todo (bien|en orden))?$/,
  // Small-talk closers with no reference to "vos" at all.
  /^(que onda|que pasa|que tal|que se cuenta|que necesitas|todo bien|todo en orden|algo mas)( vos| por ahi| por alla| che)?$/,
  // Tag questions.
  /^(no|verdad|viste|eh|dale|ok|right)$/,
  // English.
  /^(and )?(what|how) about you$/,
  /^you$/,
  // `normalise` turns "what's" into "what s" — the apostrophe becomes a space
  // like any other punctuation, so the pattern matches that, not the raw text.
  /^what s up( with you)?$/,
  /^how are you( doing)?$/,
  /^anything else$/,
];

/**
 * Is the question an answer closes on a return question — "¿y vos?", "¿qué
 * onda?", "what about you?" — rather than something the bot actually needs
 * answered?
 *
 * This is the other half of the 121 reply-window hits measured 2026-09-06..10:
 * the bot habitually closes a casual answer with a return question, and that
 * used to open the same wide window as a real one like "¿desde qué ciudad lo
 * calculo?". Judged on the *last* question sentence of the answer (see
 * `closingClause`), so it still catches "Todo bien, ¿vos cómo andás?" and
 * still leaves alone a real question that happens to have a comma in it, like
 * "¿Cuál de las dos, la de Rada o la de Casero?" — which a value-asking word
 * rules out regardless of shape.
 */
export function isReturnQuestion(sentence) {
  const clause = normalise(closingClause(sentence));
  if (!clause || VALUE_ASKING_WORDS.test(clause)) return false;
  return RETURN_QUESTION_PATTERNS.some((pattern) => pattern.test(clause));
}
