/**
 * Modes: the bot being somebody else for a while.
 *
 * The bot is a friend in a call — funny, opinionated, carrying whatever
 * standing instructions the room has given it about how to insult people back.
 * That is the point of it, and it is exactly the wrong character for the jobs
 * where being wrong has consequences. A bot that can look at a game server's
 * logs should not answer in the register of one whose instructions include
 * what to reply to "la concha de tu madre".
 *
 * So a mode is a named character it steps into: its own rules, its own tools,
 * its own list of who may invoke it, and — the part that decides whether any
 * of this is any good — its own answers for when the thing it depends on is
 * not there. See docs/plans/personalities.md.
 *
 * What a mode does NOT change is the layer below: one to three sentences,
 * plain spoken language, answer in the language you were addressed in. Those
 * are what make the bot usable in a voice channel at all, not what make it
 * funny, and every mode keeps them.
 */
import { config } from '../config.js';
import { normalise } from './wake.js';

/**
 * The rules every mode inherits before its own.
 *
 * Written once here rather than copied into each declaration: a mode author is
 * describing a character, and the things that are true of all of them — that
 * the transcript is unreliable, that a tool that cannot answer must say so
 * rather than guess — are not part of anybody's character.
 */
const COMMON_RULES = `

You are in a mode right now: a narrower job than usual, with its own rules
below. While you are in it:
- The room's usual standing instructions do not apply. You are not being the
  same character; do not reach for jokes, nicknames or running gags from
  outside this job.
- Your tools are only the ones listed for this mode. If someone asks for
  something outside it, say in one sentence that it is not what you are doing
  right now, and that they can take you out of the mode.
- **Never answer from memory about the thing this mode is for.** If a tool
  cannot tell you, say you could not find out. A confident answer about a
  machine you did not look at is the worst thing you can produce here, and it
  sounds exactly like a real one.
- Someone can take you out of the mode by asking. Do it without arguing.`;

/**
 * What the bot is called when it is being nobody in particular.
 *
 * A mode is stepped out of by naming what should come back, so the default
 * character needs a name too — otherwise "que vuelva espejo" has nothing to
 * refer to. Its phrasings are all verb-and-name constructions on purpose:
 * a bare "espejo" is the wake word and appears in every single thing anybody
 * says to the bot, so a bare name can never mean "switch".
 */
export const DEFAULT_PERSONA = {
  name: 'espejo',
  displayName: 'espejo',
  spoken: [
    'que vuelva espejo', 'que vuelvas a ser espejo', 'volve a ser espejo', 'volvé a ser espejo',
    'que vuelva el espejo', 'que vuelva el chatbot', 'que vuelva el de siempre',
    'que vuelva el default', 'volve a ser vos', 'volvé a ser vos', 'se vos de nuevo',
    'sali del modo', 'salite del modo', 'termina el modo', 'terminá el modo', 'modo normal',
    'bring back espejo', 'leave the mode', 'exit the mode', 'back to normal', 'be yourself again',
  ],
};

/**
 * One mode.
 *
 * `displayName` is what it is called out loud — the room asks for a character
 * by name, not for a "mode", and a second and third one will only be
 * distinguishable that way. `spoken` are the phrasings people actually use to
 * ask for it, in both languages the room speaks.
 *
 * `voice` is which OpenAI voice it answers in. A different character with the
 * same voice is a costume; the voice is most of what makes the switch audible
 * from the other side of a call.
 *
 * `enterRole` and `actRole` are Discord role names: the first gates turning
 * the mode on, the second gates the verbs that change something. They are
 * separate fields pointing at the same role today, because the day one of them
 * moves is the day the distinction has to already exist.
 */
/**
 * The characters this bot has, from the configuration.
 *
 * Not a constant in this file, and that is the whole point of the shape: a
 * character names a Discord role, a text channel and a job — facts about one
 * particular group of friends, which have no business being in a repository
 * anybody can read. What is general is the framework: a named character with
 * its own rules, its own tools, its own voice and its own gate. Which
 * characters exist is theirs to write.
 *
 * Invalid JSON is not worth crashing a voice call over: it becomes no
 * characters and one line in the log, the same way a broken MCP entry does.
 */
export function characters() {
  const raw = config.get('characters');
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((mode) => mode?.name && mode?.spoken?.length);
  } catch (err) {
    console.warn(`[mode] the characters setting is not valid JSON, so there are none: ${err.message}`);
    return [];
  }
}

/** A mode by name, or undefined. */
export function modeByName(name) {
  return characters().find((mode) => mode.name === name);
}

/**
 * Which mode is being asked for, if any.
 *
 * A plain phrase match rather than fuzzy scoring: the phrases are short, the
 * transcript mangles long words more than short ones, and a wrong match here
 * changes the bot's character rather than costing a round trip. Accents and
 * punctuation go, because speech recognition is inconsistent about both.
 */
export function findMode(said) {
  const heard = normalise(said ?? '');
  if (!heard) return null;
  for (const mode of characters()) {
    if (mode.spoken.some((phrase) => heard.includes(normalise(phrase)))) return mode;
  }
  return null;
}

/**
 * Is this a request to change character, either way?
 *
 * The cascade needs this before any model sees the question. Its fast leg has
 * no mode tools at all, and asked to switch it will happily say "dale, modo
 * zomboid" and change nothing — the exact failure music mode had, found in a
 * real call: the room believed the bot was muted and it was not.
 *
 * Built from the declarations rather than from a second list of regexes, so a
 * mode added tomorrow is routed correctly without anyone remembering to come
 * back here.
 */
export function looksLikeModeCommand(said) {
  const heard = normalise(said ?? '');
  if (!heard) return false;
  const phrases = [...DEFAULT_PERSONA.spoken, ...characters().flatMap((mode) => mode.spoken)];
  return phrases.some((phrase) => heard.includes(normalise(phrase)));
}

/**
 * The prompt a mode adds, common rules first.
 *
 * Returns '' for no mode, so the caller can concatenate unconditionally.
 */
export function modePrompt(mode) {
  if (!mode) return '';
  return COMMON_RULES + (mode.prompt ?? '');
}

/** What to tell the agent it can be asked to become. */
export function describeModes() {
  return characters().map(
    (mode) => `"${mode.name}" (${mode.displayName}), asked for as ${mode.spoken.slice(0, 3).map((p) => `"${p}"`).join(' or ')}`,
  ).join('; ');
}

/**
 * What the agent is told about modes, in the prompt every session carries.
 *
 * Generated rather than written out, for the same reason as above: the day a
 * mode is added, the paragraph that tells the model it exists should not be a
 * separate thing to remember.
 */
export function modesParagraph() {
  if (!characters().length) return '';
  return `

**Your other characters.** You can be asked to become one of them, each with its own name, its own rules and its own tools: ${describeModes()}. When somebody asks for one by name — "que venga el bot de zomboid", "poné el bot de zomboid" — call enter_mode; it will refuse if that person is not allowed, and you say the refusal out loud. When somebody asks for the default one back — "que vuelva espejo", "volvé a ser vos", "salí del modo" — call leave_mode, whoever put you in it.

Two things about this. Never merely say you have changed character: without the tool nothing has changed and the room will believe you. And they always call you by the same name, "${DEFAULT_PERSONA.name}", whichever character you are being — that is how they get your attention, not a request to change back. Only the phrasings above are a request to change.`;
}

export { COMMON_RULES };
