/**
 * Cutting a stream of text into things worth saying out loud.
 *
 * The point is to start talking before the model has finished thinking.
 * Measured on a real reply: the whole answer lands at 2963ms, but the first
 * sentence exists at 2008ms — and synthesising that one sentence takes 920ms
 * against 1441ms for the lot. Speaking from the first sentence puts audio in
 * the channel about a second and a half sooner.
 *
 * What makes it hold together after that first sentence is that **speech is
 * slower than synthesis**: a sentence takes two or three seconds to say and
 * under one to render, so once the voice starts, the next chunk is always
 * ready before the current one runs out. The gap only ever exists at the
 * start.
 *
 * A wrong split is worse than a late one — "dos punto" then "cinco por ciento"
 * is a stutter no listener forgives — so the boundary rules below are
 * deliberately conservative.
 *
 * And every split has a price even when it lands right. Each chunk is its own
 * request to the synthesiser, which reads the end of its text as the end of a
 * thought and starts the next one afresh; each join is half a second of dead
 * air (the trailing silence of one piece, the leading silence of the next).
 * Listened to side by side, the same reply in one request and in three was
 * the difference between a voice and a robot. So the first sentence goes
 * alone, to start early, and what follows goes in as few pieces as possible.
 */

/**
 * Don't end a sentence on these: they take a full stop and keep going.
 * Spanish and English both, since this channel switches mid-conversation.
 */
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'srta', 'dr', 'dra', 'lic', 'ing', 'prof', 'av', 'aprox', 'etc',
  'ej', 'pág', 'pag', 'núm', 'num', 'depto', 'ud', 'uds', 'vs', 'cf',
  'mr', 'mrs', 'ms', 'st', 'jr', 'inc', 'ltd', 'approx', 'no', 'fig', 'al',
]);

/**
 * Shortest thing worth sending to the synthesiser on its own.
 *
 * "Sí." rendered alone is a bark followed by a pause; better to let it ride
 * along with what comes next. Long enough to sound deliberate, short enough
 * that the first chunk still arrives early.
 */
const MIN_CHUNK = 24;

/**
 * Longest we'll wait for punctuation before cutting anyway.
 *
 * Models sometimes produce a clause that runs on well past any full stop. At
 * some point waiting for a boundary costs more than breaking at a comma.
 */
const MAX_CHUNK = 240;

/**
 * Shortest later chunk.
 *
 * Only the first chunk is ever waited for: every later one is rendered while
 * the previous one is still being said. So once the voice has started there
 * is no hurry to cut, and a bigger piece is one fewer join. Two or three
 * short sentences go to the synthesiser together; a reply of one to three
 * sentences (the prompt's own limit) is two requests at most.
 */
const LATER_CHUNK = 160;

/**
 * Could this character open a sentence?
 *
 * Lowercase says the previous punctuation was doing something else — closing
 * a quote, ending an abbreviation the list above missed. Waiting for proof is
 * cheap: the cost of a wrong split is a stutter, the cost of a late one is
 * one more delta.
 */
function startsSentence(char) {
  if (/[¿¡"'«([\d]/.test(char)) return true;
  return char === char.toUpperCase() && char !== char.toLowerCase();
}

/** True when a full stop at `index` really ends a sentence. */
function isBoundary(text, index) {
  const before = text.slice(0, index);
  const char = text[index];

  // Decimals and version numbers: "2.5", "v1.2.3".
  if (char === '.' && /\d$/.test(before) && /^\d/.test(text.slice(index + 1))) return false;

  // Abbreviations: "Sr." keeps going.
  if (char === '.') {
    const word = before.match(/([\p{L}]+)$/u)?.[1]?.toLowerCase();
    if (word && ABBREVIATIONS.has(word)) return false;
    // A single letter before a stop is an initial ("J. R. R.").
    if (word && word.length === 1) return false;
  }

  return true;
}

/**
 * Accumulates deltas and hands back complete chunks as they become sayable.
 *
 * Usage: `push()` each delta, speak whatever it returns; `flush()` at the end
 * for the tail that never got its full stop.
 */
export class SentenceSplitter {
  constructor({ minChunk = MIN_CHUNK, maxChunk = MAX_CHUNK, laterChunk = LATER_CHUNK } = {}) {
    this.buffer = '';
    this.minChunk = minChunk;
    this.maxChunk = maxChunk;
    this.laterChunk = laterChunk;
    this.taken = 0;
  }

  /** Feed a delta. Returns zero or more chunks ready to be spoken. */
  push(delta) {
    this.buffer += delta ?? '';
    const out = [];

    for (;;) {
      const chunk = this.#take();
      if (!chunk) break;
      out.push(chunk);
    }
    return out;
  }

  #take() {
    // Punctuation, an optional closing quote or bracket, whitespace, and then
    // the start of something new. That last part is load-bearing: in
    // «le pregunté "¿venís?" y no contestó» the question mark is mid-sentence,
    // and the lowercase "y" is the only thing that says so.
    const pattern = /[.!?…]+["'»)\]]?\s+(\S)/g;
    let match;
    while ((match = pattern.exec(this.buffer))) {
      // End of the chunk: through the punctuation and its closer, before the
      // whitespace that follows.
      const end = match.index + match[0].replace(/\s+\S$/, '').length;
      if (!isBoundary(this.buffer, match.index)) continue;
      if (!startsSentence(match[1])) continue;
      // Too short to stand alone; or, once the voice has started, too short
      // to be worth a join.
      if (end < (this.taken === 0 ? this.minChunk : this.laterChunk)) continue;
      return this.#cut(end);
    }

    // Nothing punctuated, and it's gone on long enough — break at the last
    // comma so the pause lands somewhere a person would have paused too.
    if (this.buffer.length >= this.maxChunk) {
      const cut = this.buffer.lastIndexOf(', ', this.maxChunk);
      const at = cut > this.minChunk ? cut + 1 : this.maxChunk;
      return this.#cut(at);
    }

    return null;
  }

  #cut(end) {
    const chunk = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end).trimStart();
    this.taken += 1;
    return chunk;
  }

  /** Whatever is left, once the model has stopped producing. */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest;
  }
}

export { MIN_CHUNK, MAX_CHUNK, LATER_CHUNK, ABBREVIATIONS };
