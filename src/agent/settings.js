/**
 * The settings the bot can read out and change when asked to.
 *
 * The config object holds the Discord token and two API keys next to the
 * choice of voice. So this is a closed list rather than a view over the
 * config: a setting is reachable by voice because it appears here, and the
 * secrets are unreachable because they don't — not because something
 * downstream remembers to filter them out. The same list serves reading and
 * writing, so there is no way to describe a value that cannot also be changed,
 * or to change one that cannot be described.
 *
 * Values arrive as speech, which means they arrive wrong: "en esta máquina"
 * for `local`, "la API" for `openai`, "prendelo" for `true`. Each setting
 * therefore parses rather than validates, and refuses by naming the options it
 * does accept — the agent reads that refusal back to the room, so a rejected
 * value teaches instead of just failing.
 *
 * What is deliberately absent: the token, both API keys, the web port, and the
 * guild. Keys because a spoken secret is both useless (transcription mangles
 * it) and harmful (it would land in the transcript, the model's context, and
 * the console). The port and guild because changing them mid-call breaks the
 * thing you would use to fix them. MCP servers, folders, names and standing
 * instructions have their own tools, with their own rules.
 */
import { normalise } from './wake.js';

export class SettingError extends Error {}

/** Spoken words that mean yes and no, in both languages people use here. */
const YES = ['on', 'yes', 'true', 'si', 'enabled', 'activado', 'encendido', 'prendido', 'prendelo', 'activalo'];
const NO = ['off', 'no', 'false', 'disabled', 'desactivado', 'apagado', 'apagalo', 'desactivalo'];

function choice(options) {
  return {
    kind: 'choice',
    options,
    parse(spoken) {
      const said = normalise(spoken ?? '');
      if (!said) throw new SettingError('No value given.');
      for (const option of options) {
        if (option.aliases.some((a) => said === normalise(a) || said.includes(normalise(a)))) {
          return option.value;
        }
      }
      throw new SettingError(`"${spoken}" isn't one of: ${options.map((o) => o.value).join(', ')}.`);
    },
    describe(value) {
      return options.find((o) => o.value === value)?.label ?? String(value);
    },
  };
}

function flag() {
  return {
    kind: 'flag',
    options: [{ value: true }, { value: false }],
    parse(spoken) {
      const said = normalise(spoken ?? '');
      if (YES.some((w) => said === w || said.startsWith(`${w} `))) return true;
      if (NO.some((w) => said === w || said.startsWith(`${w} `))) return false;
      throw new SettingError(`"${spoken}" isn't a yes or a no.`);
    },
    describe(value) {
      return value ? 'on' : 'off';
    },
  };
}

function number({ min, max, unit }) {
  return {
    kind: 'number',
    parse(spoken) {
      // Speech gives "90", "90 seconds", "noventa segundos". Digits are the
      // only part that survives reliably, so that is what we read.
      const digits = String(spoken ?? '').match(/-?\d+/);
      if (!digits) throw new SettingError(`"${spoken}" isn't a number.`);
      const n = Number(digits[0]);
      if (n < min || n > max) {
        throw new SettingError(`${n} is outside ${min}–${max} ${unit}.`);
      }
      return n;
    },
    describe(value) {
      return `${value} ${unit}`;
    },
  };
}

/**
 * A model name, or nothing.
 *
 * Free text, because the list of models changes faster than this bot does, so
 * an allow-list would be wrong within months. The checks are only the ones
 * that catch a sentence arriving where an identifier belongs — an unusable
 * name breaks every answer until someone fixes it in the panel, and a
 * half-heard one is far likelier than a real one nobody has heard of.
 */
const modelName = {
  kind: 'text',
  parse(spoken) {
    const said = String(spoken ?? '').trim();
    if (!said || ['default', 'blank', 'none', 'por defecto', 'ninguno'].includes(said.toLowerCase())) {
      return '';
    }
    const name = said.replace(/\s+/g, '-').toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(name)) {
      throw new SettingError(
        `"${spoken}" doesn't look like a model name. Say it as it's written, like claude-haiku-4-5.`,
      );
    }
    return name;
  },
  describe(value) {
    return value || 'the provider default';
  },
};

/**
 * The settings, in the order a person would ask about them.
 *
 * `session` marks the ones that are part of what an agent session was built
 * from: changing those starts a new session, which forgets the conversation.
 * The tool says so, because a bot that silently loses the thread right after
 * being asked to change something looks broken in a way that is hard to
 * attribute to the change.
 */
export const SETTINGS = [
  {
    name: 'speaking',
    aliases: ['voice provider', 'tts', 'habla', 'voz', 'speech'],
    key: 'ttsProvider',
    what: 'where the voice is synthesised',
    type: choice([
      { value: 'openai', label: 'OpenAI (API)', aliases: ['openai', 'open ai', 'api', 'cloud', 'la nube', 'remoto'] },
      {
        value: 'local',
        label: 'Piper on this machine',
        aliases: ['local', 'piper', 'this machine', 'esta maquina', 'aca', 'offline', 'sin internet'],
      },
    ]),
  },
  {
    name: 'voice',
    aliases: ['tts voice', 'la voz', 'accent', 'acento'],
    // Which field this writes depends on which provider is in use, so that
    // "use nova" while on OpenAI and "use daniela" while on Piper both land
    // where the next sentence will actually read them.
    key: (values) => (values.ttsProvider === 'local' ? 'ttsLocalVoice' : 'ttsVoice'),
    keys: ['ttsVoice', 'ttsLocalVoice'],
    what: 'which voice speaks',
    type: {
      kind: 'choice',
      parse(spoken, values) {
        const options =
          values.ttsProvider === 'local'
            ? ['es_ES-davefx-medium', 'en_US-lessac-medium', 'es_AR-daniela-high']
            : ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        const said = normalise(spoken ?? '');
        const hit = options.find((o) => normalise(o) === said || normalise(o).includes(said));
        if (!hit) {
          throw new SettingError(
            `"${spoken}" isn't one of the ${values.ttsProvider === 'local' ? 'Piper' : 'OpenAI'} voices: ${options.join(', ')}.`,
          );
        }
        return hit;
      },
      describe: (value) => value,
    },
  },
  {
    name: 'hearing',
    aliases: ['stt', 'transcription', 'transcripcion', 'oido', 'escucha'],
    key: 'sttProvider',
    what: 'where speech is transcribed',
    type: choice([
      { value: 'openai', label: 'OpenAI whisper-1 (API)', aliases: ['openai', 'open ai', 'api', 'cloud', 'la nube', 'remoto'] },
      {
        value: 'local',
        label: 'whisper.cpp on this machine',
        aliases: ['local', 'whisper cpp', 'this machine', 'esta maquina', 'aca', 'offline', 'sin internet'],
      },
    ]),
  },
  {
    name: 'hearing model',
    aliases: ['whisper model', 'modelo de whisper'],
    key: 'sttLocalModel',
    what: 'which whisper.cpp model runs when hearing is local',
    type: choice([
      { value: 'ggml-base', label: 'base (142MB, quick on a CPU)', aliases: ['base'] },
      { value: 'ggml-small', label: 'small (466MB, better without a GPU)', aliases: ['small', 'chico'] },
      {
        value: 'ggml-large-v3-turbo',
        label: 'large-v3-turbo (1.6GB, for a GPU)',
        aliases: ['large', 'turbo', 'grande'],
      },
    ]),
  },
  {
    name: 'thinking',
    aliases: ['brain', 'cerebro', 'mode', 'modo'],
    key: 'brainKind',
    what: 'whether answers come from a persistent agent session or one call each',
    session: true,
    type: choice([
      {
        value: 'agent',
        label: 'a Claude agent session with tools and memory',
        aliases: ['agent', 'agente', 'con herramientas', 'con memoria'],
      },
      {
        value: 'chat',
        label: 'one API call per answer, no memory or tools',
        aliases: ['chat', 'directo', 'direct', 'simple'],
      },
      {
        value: 'cascade',
        label: 'a fast model in front of the agent, handing over what needs tools',
        aliases: ['cascade', 'cascada', 'mixto', 'hybrid', 'rapido', 'fast path'],
      },
    ]),
  },
  {
    name: 'fast model',
    aliases: ['front model', 'modelo rapido', 'quick model'],
    key: 'fastModel',
    what: 'which model answers first in cascade mode, before anything is handed over',
    session: true,
    type: modelName,
  },
  {
    name: 'model',
    aliases: ['brain model', 'modelo', 'which model'],
    key: 'brainModel',
    what: 'which model answers',
    session: true,
    type: modelName,
  },
  {
    name: 'web search',
    aliases: ['search', 'busqueda', 'internet', 'buscar en internet'],
    key: 'webSearch',
    what: 'whether it may look things up',
    session: true,
    type: flag(),
  },
  {
    name: 'tool rounds',
    aliases: ['max turns', 'rondas', 'vueltas'],
    key: 'agentMaxTurns',
    what: 'how many tool-using rounds one answer may take',
    session: true,
    type: number({ min: 1, max: 25, unit: 'rounds' }),
  },
  {
    name: 'memory',
    aliases: ['buffer', 'audio buffer', 'cuanto recuerda', 'ventana'],
    key: 'bufferSeconds',
    what: 'how many seconds of audio are kept to transcribe',
    type: number({ min: 10, max: 600, unit: 'seconds' }),
  },
  {
    name: 'wake',
    aliases: ['wake word', 'answer when addressed', 'que responda cuando lo nombran'],
    key: 'wakeEnabled',
    what: 'whether saying its name is enough to get an answer',
    type: flag(),
  },
  {
    name: 'listening',
    // Turning this off self-deafens the bot, so it cannot hear itself being
    // turned back on. That is a real corner, but not a trap: /mj listen and
    // the control panel both undo it, and refusing a plain "stop listening"
    // from a voice assistant would be the stranger behaviour.
    aliases: ['deaf', 'mute yourself', 'dejar de escuchar', 'sordo'],
    key: 'agentEnabled',
    what: 'whether it hears the channel at all',
    type: flag(),
  },
  {
    name: 'eager transcription',
    aliases: ['transcribe as we speak', 'transcripcion inmediata'],
    key: 'eagerTranscription',
    what: 'whether each utterance is transcribed as it is spoken, which is what makes fast answers possible',
    type: flag(),
  },
  {
    name: 'folders',
    aliases: ['directories', 'carpetas', 'agent directories'],
    key: 'agentDirectories',
    what: 'which folders on this machine a filesystem MCP server can reach',
    session: true,
    // The one entry here that is a security boundary rather than a preference:
    // it decides what a connected server may read. Same bar as configuring the
    // server itself.
    ownerOnly: true,
    type: {
      kind: 'text',
      parse(spoken) {
        const said = String(spoken ?? '').trim();
        if (!said || ['none', 'ninguna', 'nothing', 'nada'].includes(said.toLowerCase())) return '';
        // Dictated paths are unreliable enough that this refuses anything that
        // isn't already a full path, rather than guessing at a folder.
        const lines = said.split('\n').map((l) => l.trim()).filter(Boolean);
        const bad = lines.find((l) => !/^(\/|[A-Za-z]:[\\/])/.test(l));
        if (bad) {
          throw new SettingError(`"${bad}" isn't a full path. Ask them to type it in the panel instead.`);
        }
        return lines.join('\n');
      },
      describe: (value) => (value ? value.split('\n').join(', ') : 'none'),
    },
  },
];

/** Every config key the registry touches — and, by construction, no others. */
export function settingKeys() {
  const keys = new Set();
  for (const setting of SETTINGS) {
    if (typeof setting.key === 'string') keys.add(setting.key);
    for (const key of setting.keys ?? []) keys.add(key);
  }
  return [...keys];
}

/**
 * The slice of the config the settings tools work on.
 *
 * Taking a getter rather than the config object is what keeps the secrets out:
 * this can only ever read the keys the registry declares, so there is no
 * object in play that contains a token and could be passed somewhere it
 * shouldn't be.
 */
export function settingsSnapshot(get) {
  return Object.fromEntries(settingKeys().map((key) => [key, get(key)]));
}

/** Which config key a setting writes, given the current values. */
export function keyOf(setting, values) {
  return typeof setting.key === 'function' ? setting.key(values) : setting.key;
}

/** Find a setting by whatever the agent called it, or refuse listing the names. */
export function findSetting(spoken) {
  const said = normalise(spoken ?? '');
  if (!said) throw new SettingError('No setting named.');

  const candidates = SETTINGS.map((s) => ({ s, names: [s.name, ...(s.aliases ?? [])].map(normalise) }));
  const exact = candidates.find((c) => c.names.includes(said));
  if (exact) return exact.s;

  // "the speaking provider" should reach `speaking`. Longest match wins so
  // that "hearing model" doesn't resolve to "hearing".
  const partial = candidates
    .filter((c) => c.names.some((n) => said.includes(n) || n.includes(said)))
    .sort((a, b) => Math.max(...b.names.map((n) => n.length)) - Math.max(...a.names.map((n) => n.length)));
  if (partial.length) return partial[0].s;

  throw new SettingError(
    `There's no setting called "${spoken}". There is: ${SETTINGS.map((s) => s.name).join(', ')}.`,
  );
}

/**
 * Everything the bot may say about how it is set up.
 *
 * Built from the registry, so a secret cannot appear here by being added to
 * the config — it would have to be added to this file, next to the paragraph
 * saying not to.
 */
export function describeSettings(values) {
  return SETTINGS.map((setting) => {
    const value = values[keyOf(setting, values)];
    return `${setting.name}: ${setting.type.describe(value, values)} — ${setting.what}`;
  }).join('\n');
}

/**
 * Work out the change without making it.
 *
 * Returns the patch for the caller to apply, so that the permission check and
 * the write stay in the tool where the asker is known, and everything that can
 * go wrong happens before anything is written.
 */
export function planChange(values, spokenName, spokenValue) {
  const setting = findSetting(spokenName);
  const key = keyOf(setting, values);
  const before = values[key];
  const after = setting.type.parse(spokenValue, values);

  return {
    setting,
    key,
    before,
    after,
    unchanged: before === after,
    patch: { [key]: after },
    describeBefore: setting.type.describe(before, values),
    describeAfter: setting.type.describe(after, values),
  };
}
