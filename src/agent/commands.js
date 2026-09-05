/**
 * Music commands carried out without a model.
 *
 * "Espejo, saltá" used to travel the whole answer path: fast leg, escalation,
 * agent, tool call, four to nine seconds for a thing a person does in one
 * click. When the utterance is unmistakably one of the commands the music
 * tools already carry out, the command is matched here and run directly:
 * zero seconds of thinking, the same note in the music channel, the same
 * silence afterwards.
 *
 * Narrow on purpose. The matcher is stricter than the routing list in
 * cascade.js: the whole utterance, minus the bot's names and a few filler
 * words, has to be the command and nothing else, so "saltá la parte aburrida
 * de la peli" and a bare "seguí" stay ordinary talk. "Play" is never handled
 * here: its query needs the model's correction of what the transcriber heard.
 * A miss costs nothing but the old path; a false positive would pause a song
 * nobody asked to pause, so the miss is the side to fail on.
 */
import { config } from '../config.js';
import { splitNames } from './wake.js';
import { noteInMusicChannel } from './tools/music.js';

/** Tool names as `ask()` knows them, so a command counts as a silent tool. */
const TOOL = {
  skip: 'mcp__bot__skip_song',
  stop: 'mcp__bot__stop_music',
  pause: 'mcp__bot__pause_music',
  resume: 'mcp__bot__resume_music',
  volume: 'mcp__bot__set_volume',
};

/** Words that may surround a command without changing it. */
const FILLER = new Set([
  'che', 'dale', 'por', 'favor', 'porfa', 'porfi', 'please', 'ahora', 'ya', 'eh', 'y', 'bueno',
  'un', 'una', 'el', 'la', 'lo', 'este', 'esta', 'ese', 'esa', 'esto', 'eso', 'the', 'this', 'that',
  'tema', 'cancion', 'musica', 'song', 'music', 'track', 'sonido', 'de', 'con', 'a', 'al',
]);

/** Time words that turn "pará" into a pause rather than a stop. */
const MOMENT = new Set(['segundo', 'segundito', 'toque', 'momento', 'cachito', 'rato', 'ratito', 'poco', 'poquito', 'second', 'sec', 'moment']);
/** Object words that make "pará" a stop, and that a volume request has to name. */
const MUSIC = new Set(['musica', 'cancion', 'tema', 'song', 'music', 'track', 'sonido']);

const SKIP = new Set(['skip', 'saltea', 'salteala', 'saltealo', 'salta', 'saltala', 'saltalo', 'siguiente', 'next', 'proxima', 'proximo']);
const STOP_VERB = new Set(['para', 'pare', 'frena', 'detene', 'stop', 'corta', 'cortala', 'cortalo', 'apaga', 'apagala', 'apagalo']);
const PAUSE = new Set(['pausa', 'pausala', 'pausalo', 'pause']);
const RESUME = new Set(['reanuda', 'reanudala', 'reanudalo', 'despausa', 'despausala', 'resume']);
const CONTINUE = new Set(['segui', 'continua', 'seguila', 'continuala']);
const LOWER = new Set(['baja', 'bajale', 'bajalo', 'bajala', 'bajame', 'bajen', 'lower', 'down']);
const RAISE = new Set(['subi', 'subile', 'subilo', 'subila', 'subime', 'suban', 'sube', 'raise', 'up']);
const LOUDER = new Set(['fuerte', 'alto', 'arriba', 'louder']);
const SOFTER = new Set(['bajo', 'abajo', 'quieter', 'softer']);
const A_LITTLE = new Set(['poco', 'poquito', 'toque', 'cachito', 'little', 'bit']);
const A_LOT = new Set(['bastante', 'mucho', 'bien', 'lot']);

/** Lowercase, accents stripped, split into words; the bot's names removed. */
function words(text) {
  const names = new Set(splitNames(config.get('agentNames')).map((n) => fold(n)));
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !names.has(w));
}

const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Ways of telling it to stop talking, mid-sentence. */
const HUSH = new Set([
  'basta', 'callate', 'callese', 'shh', 'sh', 'shhh', 'silencio', 'suficiente', 'cortala', 'cortalo', 'corta',
  'para', 'deja', 'hablar', 'hush', 'enough', 'quiet', 'be', 'shut', 'up', 'stop', 'talking', 'it',
]);
/** At least one of these has to be there: "de" and "be" alone are nothing. */
const HUSH_CORE = new Set(['basta', 'callate', 'callese', 'shh', 'sh', 'shhh', 'silencio', 'suficiente', 'cortala', 'cortalo', 'corta', 'para', 'hablar', 'hush', 'enough', 'quiet', 'shut', 'stop']);

/**
 * "Espejo, basta": is this someone cutting the bot off?
 *
 * Only meaningful while it is talking, which the caller checks; the same
 * words at any other time are ordinary talk and go to the model. The whole
 * utterance, minus the names and fillers, has to be the request.
 */
export function matchHush(text) {
  const all = words(text);
  // "Pará la música" is about the music, not about the voice.
  if (all.some((w) => MUSIC.has(w))) return false;
  const rest = all.filter((w) => !FILLER.has(w));
  if (!rest.length || rest.length > 4) return false;
  return rest.every((w) => HUSH.has(w)) && rest.some((w) => HUSH_CORE.has(w));
}

/**
 * The command in an utterance, or null when it is anything else.
 *
 * Returns `{ kind }` for skip, stop, pause and resume; `{ kind: 'volume',
 * change }` or `{ kind: 'volume', level }` for the volume.
 */
export function matchCommand(text) {
  const all = words(text);
  if (!all.length) return null;
  const rest = all.filter((w) => !FILLER.has(w));
  const has = (set) => all.some((w) => set.has(w));
  const only = (...sets) => rest.every((w) => sets.some((s) => s.has(w)));

  // "pasá de tema", "cambiá el tema": the verb alone is nothing, with the
  // object it is a skip.
  if (rest.length && only(SKIP)) return { kind: 'skip' };
  if ((rest.includes('pasa') || rest.includes('cambia')) && has(MUSIC) && only(new Set(['pasa', 'cambia']))) {
    return { kind: 'skip' };
  }

  if (rest.length && only(PAUSE)) return { kind: 'pause' };
  if (rest.length && only(RESUME)) return { kind: 'resume' };
  // A bare "seguí" is ordinary talk; "seguí con la música" is a resume.
  if (rest.length && only(CONTINUE) && has(MUSIC)) return { kind: 'resume' };

  if (rest.length && only(STOP_VERB, MOMENT)) {
    // "pará un segundo" pauses; "pará la música" and a bare "pará" stop.
    // The bare form is the destructive reading only when the queue is about
    // to be heard again anyway: the runner refuses when nothing is playing.
    if (has(MOMENT)) return { kind: 'pause' };
    if (rest.some((w) => w === 'stop') || has(MUSIC) || rest.length === 1) return { kind: 'stop' };
  }

  const volume = matchVolume(all, rest);
  if (volume) return volume;

  return null;
}

function matchVolume(all, rest) {
  const named = all.includes('volumen') || all.includes('volume') || all.some((w) => MUSIC.has(w));
  const level = all.find((w) => /^\d{1,3}$/.test(w));
  const direction = (() => {
    if (rest.some((w) => LOWER.has(w))) return -1;
    if (rest.some((w) => RAISE.has(w))) return 1;
    if ((all.includes('mas') || all.includes('more')) && rest.some((w) => LOUDER.has(w))) return 1;
    if ((all.includes('mas') || all.includes('more')) && rest.some((w) => SOFTER.has(w))) return -1;
    if (all.includes('menos') && named) return -1;
    return 0;
  })();
  if (!direction && !level) return null;
  // Everything else in the sentence has to be about the volume.
  const allowed = [LOWER, RAISE, LOUDER, SOFTER, A_LITTLE, A_LOT, new Set(['volumen', 'volume', 'mas', 'more', 'menos', 'ponelo', 'ponela', 'pone', 'al', 'a'])];
  if (!rest.every((w) => /^\d{1,3}$/.test(w) || allowed.some((s) => s.has(w)))) return null;
  if (level && (all.includes('volumen') || all.includes('volume') || rest.includes('ponelo') || rest.includes('ponela'))) {
    return { kind: 'volume', level: Number(level) };
  }
  if (!direction || !named && !rest.some((w) => LOUDER.has(w) || SOFTER.has(w))) return null;
  const size = rest.some((w) => A_LOT.has(w)) ? 30 : rest.some((w) => A_LITTLE.has(w)) ? 10 : 15;
  return { kind: 'volume', change: direction * size };
}

/**
 * Carry a matched command out on the session's music, and write the same
 * note the tool would have written.
 *
 * Returns the tool name it stood in for, or null when there was nothing to
 * act on (nothing playing, not paused), in which case the model takes the
 * question and says so in its own words, as it did before.
 */
export async function runCommand(command, { session, guildId, askedBy }) {
  const music = session?.music;
  if (!music) return null;
  const turn = { guildId, askerName: askedBy, guild: () => session.client?.guilds?.cache?.get(guildId) ?? null };

  switch (command.kind) {
    case 'skip': {
      const skipped = music.skip();
      if (!skipped) return null;
      const next = music.queue?.[0];
      await noteInMusicChannel(turn, `⏭️  saltado: ${skipped.title}${next ? `  →  **${next.title}**` : ''}`);
      return TOOL.skip;
    }
    case 'stop': {
      if (!music.playing) return null;
      music.stop();
      await noteInMusicChannel(turn, '⏹️  música detenida, cola vacía');
      return TOOL.stop;
    }
    case 'pause':
      return music.pause() ? TOOL.pause : null;
    case 'resume':
      return music.resume() ? TOOL.resume : null;
    case 'volume': {
      const { from, to, applied } = music.setVolume(
        command.level !== undefined ? { level: command.level } : { change: command.change },
      );
      if (!applied || from === to) return null;
      await noteInMusicChannel(turn, `🔊  volumen: ${from}% → ${to}%`);
      return TOOL.volume;
    }
    default:
      return null;
  }
}

/**
 * The whole thing, for the cascade: match, run, and report the tool name
 * the command stood in for, or null to let the models have it.
 */
export async function handleCommand(context, guildId, { getSession }) {
  const command = matchCommand(context.question);
  if (!command) return null;
  const session = await getSession(guildId);
  if (!session || session.destroyed) return null;
  return runCommand(command, { session, guildId, askedBy: context.askedBy });
}
