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

export { COMMON_RULES };
