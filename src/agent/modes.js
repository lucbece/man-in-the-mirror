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
 * One mode.
 *
 * `spoken` are the phrasings people actually use to ask for it, in both
 * languages the room speaks. `enterRole` and `actRole` are Discord role names:
 * the first gates turning the mode on, the second gates the verbs that change
 * something. They are separate fields pointing at the same role today, because
 * the day one of them moves is the day the distinction has to already exist.
 */
export const MODES = [
  {
    name: 'zomboid',
    spoken: [
      'modo zomboid', 'modo admin', 'zomboid admin', 'modo servidor', 'modo server',
      'zomboid mode', 'admin mode', 'server mode',
    ],
    enterRole: 'los kpos',
    actRole: 'los kpos',
    /**
     * Which families of the bot's own tools survive. `modes` is always kept —
     * a mode nobody can leave is a bug — and everything unlisted is gone, so
     * the agent cannot wander off into the notebook or the settings while it
     * is meant to be looking at a server.
     */
    tools: ['zomboid', 'quiet'],
    /** Where a long answer goes, by channel name. The room already reads server news there. */
    detailChannel: 'project-zomboid-ñoños-chatroom',
    entering: 'Modo zomboid. Fijate que solo puedo mirar el server y decirte cómo está.',
    leaving: 'Listo, salí del modo zomboid.',
    /** Said by the bot itself when the mode times out, with nobody having asked. */
    expired: 'Hace rato que nadie me pregunta nada del server, así que vuelvo a ser yo.',
    prompt: `

# This mode: Project Zomboid admin

You are looking after the group's Project Zomboid server. Sixteen friends play
on it most nights; when it is down, nobody is playing.

Your register here is a competent sysadmin talking to the person who asked:
short, factual, no jokes, no reassurance nobody asked for. Say what is true and
stop. If something is broken, say what is broken.

What you actually know:
- The machine the game runs on turns itself off after half an hour with nobody
  playing. **That is normal, not a fault.** A server that is not answering at
  nine in the evening is almost always just off.
- You do not have the switch. Another bot does, and it is the one with the
  permissions: \`/pz start\` starts the machine and takes about three minutes,
  \`/pz status\` reports it, \`/pz stop\` stops it and refuses while anyone is
  playing. When the server is not up and somebody wants it up, tell them to
  type \`/pz start\` — anyone in the server can. Never claim you started it.
- Everything you say about the game comes from asking the game. Never state a
  player count, a version or a map from memory.`,
  },
];

/**
 * How long a mode survives with nothing asked of it.
 *
 * A character nobody ends is a character the bot is left in: the room stops
 * talking about the server, carries on with the night, and the funny bot never
 * comes back because nobody remembers the words. Fifteen minutes is long
 * enough that a real conversation about a server never trips it — every
 * question resets it — and short enough that walking away from one ends it.
 *
 * It says so when it goes. A bot that changed character silently would be
 * worse than one that stayed.
 */
export const MODE_IDLE_MS = 15 * 60 * 1000;

/**
 * The live value, in one table, the way WAKE_TIMING works in voice/session.js:
 * a test that had to wait fifteen real minutes would not be written.
 */
export const MODE_TIMING = { idleMs: MODE_IDLE_MS };

/** A mode by name, or undefined. */
export function modeByName(name) {
  return MODES.find((mode) => mode.name === name);
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
  for (const mode of MODES) {
    if (mode.spoken.some((phrase) => heard.includes(normalise(phrase)))) return mode;
  }
  return null;
}

/**
 * Ways of asking to stop being a character, which belong to no mode in
 * particular.
 */
const EXIT_PHRASES = [
  'sali del modo', 'salite del modo', 'terminá el modo', 'termina el modo',
  'volve a ser vos', 'volvé a ser vos', 'se vos de nuevo', 'modo normal',
  'leave the mode', 'exit the mode', 'back to normal', 'be yourself again',
];

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
  if (EXIT_PHRASES.some((phrase) => heard.includes(normalise(phrase)))) return true;
  return Boolean(findMode(heard));
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
  return MODES.map((mode) => `"${mode.name}", asked for as ${mode.spoken.slice(0, 3).map((p) => `"${p}"`).join(' or ')}`).join('; ');
}

/**
 * What the agent is told about modes, in the prompt every session carries.
 *
 * Generated rather than written out, for the same reason as above: the day a
 * mode is added, the paragraph that tells the model it exists should not be a
 * separate thing to remember.
 */
export function modesParagraph() {
  return `

**Modes.** You can be asked to become one of your other characters, each with its own rules and its own tools: ${describeModes()}. When somebody asks for one — "activá el modo zomboid", "ponete en modo admin" — call enter_mode; it will refuse if that person is not allowed, and you say the refusal out loud. When somebody asks you to stop — "salí del modo", "volvé a ser vos" — call leave_mode, whoever put you in it. Never merely say you have changed character: without the tool nothing has changed, and the room will believe you.`;
}

export { COMMON_RULES, EXIT_PHRASES };
