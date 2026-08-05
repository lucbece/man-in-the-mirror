/**
 * Noticing when the bot is being spoken to.
 *
 * Not a wake *phrase* — a name. People don't prefix a fixed incantation, they
 * just say your name somewhere in the sentence: "che, mirror, qué opinás de
 * esto?", "what do you reckon, mirror?", "mirror, search that for me". Matching
 * a phrase prefix gets the last of those wrong, because nothing follows the
 * name, so the question comes out empty.
 *
 * So: does its name appear anywhere in what was said? If yes, the whole
 * sentence is the request — the model can see its own name in there and work
 * out what's being asked.
 *
 * The plan originally called for an on-device wake-word engine: a native
 * dependency, a model file, build tools on Windows, and per-language training.
 * Transcribing as people speak removed the need for any of it — this is a
 * string match on text that already exists.
 */

/**
 * How close a heard name has to be.
 *
 * Loose, because speech recognition mangles names constantly — real examples
 * from live sessions: "mirra", "mirrow", "el mirror", "espejito". Being too
 * strict means being ignored, which is the worse failure: you repeat yourself
 * and nothing happens.
 *
 * Loose alone would be unusable, though. "espero" scores 0.83 against
 * "espejo" and "miro" scores 0.67 against "mirror" — both are said constantly.
 * That's what COMMON_WORDS below is for: a low bar, with the words that would
 * abuse it named explicitly.
 */
const SIMILARITY_THRESHOLD = 0.65;

/**
 * Words that are never the bot's name, no matter how close they score.
 *
 * Without this the threshold has to sit high enough to exclude "espero", which
 * also excludes "espejito" — and then half the times you call it, nothing
 * happens. Cheaper to name the collisions.
 */
const COMMON_WORDS = new Set([
  // Spanish — mostly forms of mirar/esperar, which collide hard with both names.
  //
  // The infinitive was missing from this list for a while and it showed: "el
  // que se debe mirar" woke the bot in a real call, because `mirar` scores
  // 0.667 against `mirror`. Conjugations were here; the one form people use
  // most was not. `espere` was the same oversight on the other verb.
  'mira', 'miro', 'mire', 'miren', 'mirad', 'miras', 'miralo', 'mirale',
  'mirar', 'mirarme', 'mirarte', 'mirarlo', 'mirarla', 'mirarnos', 'mirarse',
  'miraron', 'mirador', 'miradores', 'mirada', 'miradas', 'mirado', 'mirados',
  'espero', 'espera', 'esperen', 'esperá', 'esperar', 'esperando',
  'espere', 'esperes', 'esperemos', 'esperamos', 'esperaron',
  'mejor', 'viejo', 'dejo', 'dejó', 'pero', 'lejos', 'consejo', 'espejismo',
  'herrero', 'quiero', 'primero', 'tercero', 'sendero', 'dinero',
  // English
  'mirror', // only as a plain noun — handled below, kept out of this set
  'error', 'mere', 'more', 'meter', 'motor', 'minor', 'major',
]);
// "mirror" is a legitimate name; the entry above exists only to document that
// the collision was considered. Remove it so the name still matches itself.
COMMON_WORDS.delete('mirror');

/** Very short names match too loosely, so they need to be exact. */
const FUZZY_MIN_LENGTH = 5;

/** Accents, punctuation and casing are all noise for this comparison. */
export function normalise(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, iterative and allocation-light. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current.slice();
  }
  return previous[b.length];
}

export function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/** Names are configured as a comma-separated list. */
export function splitNames(names) {
  return String(names ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

/**
 * Was the bot addressed by name in this utterance?
 *
 * Returns `{ matched, name, at }`. There's deliberately no `question` field —
 * the caller passes the whole sentence on, because the name can sit anywhere
 * in it and "everything after the name" is the wrong answer half the time.
 */
export function detectAddress(text, names) {
  const haystack = normalise(text);
  if (!haystack) return { matched: false };

  const words = haystack.split(' ');
  let best = null;

  for (const rawName of splitNames(names)) {
    const needle = normalise(rawName);
    if (!needle) continue;

    const span = needle.split(' ').length;

    for (let i = 0; i + span <= words.length; i++) {
      const window = words.slice(i, i + span).join(' ');

      // An ordinary word is never a name, however close it scores.
      if (window !== needle && COMMON_WORDS.has(window)) continue;

      // Short names ("mj", "eco") collide with ordinary words under fuzzy
      // matching, so they have to land exactly.
      const matched =
        needle.length < FUZZY_MIN_LENGTH
          ? window === needle
          : similarity(window, needle) >= SIMILARITY_THRESHOLD;

      if (matched && (!best || i < best.at)) {
        best = { at: i, name: rawName };
      }
    }
  }

  return best ? { matched: true, ...best } : { matched: false, closest: closestOf(words, names) };
}

/**
 * The nearest thing to one of its names in this utterance, for logging.
 *
 * When it silently fails to notice it's being addressed, the useful question
 * is "how close did it get?" — 0.67 means transcription mangled the name,
 * while 0.2 means it was never said at all.
 */
function closestOf(words, names) {
  let best = null;
  for (const rawName of splitNames(names)) {
    const needle = normalise(rawName);
    if (!needle) continue;
    const span = needle.split(' ').length;
    for (let i = 0; i + span <= words.length; i++) {
      const window = words.slice(i, i + span).join(' ');
      const score = similarity(window, needle);
      if (!best || score > best.score) best = { score, heard: window, name: rawName };
    }
  }
  return best;
}

export { SIMILARITY_THRESHOLD, FUZZY_MIN_LENGTH, COMMON_WORDS };
