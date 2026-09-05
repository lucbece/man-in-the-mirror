import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import dotenv from 'dotenv';

import { ROOT_DIR } from './paths.js';
import { parseInstructions, serialiseInstructions } from './agent/instructions.js';

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const CONFIG_PATH = path.join(ROOT_DIR, 'data', 'config.json');

const DEFAULTS = {
  // Secrets / identity
  token: '',
  guildId: '', // optional: registers slash commands instantly on this guild only

  // Listening
  //
  // On by default, which is a deliberate change from how this started. The
  // reasoning for `false` was that hearing should be an explicit act — but the
  // bot only enters a channel when someone runs /mj join or picks one in the
  // panel, so that explicit act already happened, and a bot that sits there
  // deaf until you find a second switch reads as broken rather than as
  // careful. What actually communicates the state is unchanged: while off it
  // is self-deafened, which is both the mechanism that stops Discord sending
  // audio and a badge Discord shows next to it in the member list.
  agentEnabled: true,
  bufferSeconds: 90, // rolling audio kept in memory, never written to disk
  // Names it answers to, comma-separated. Not a fixed phrase — people address
  // it however they like ("che, mirror, qué opinás?"), so any mention counts.
  //
  // More than one on purpose: speech-to-text writes down what it expects in
  // the language it thinks it's hearing, so "hey mirror" inside a Spanish
  // sentence came back as "Amy". A name that exists in the language being
  // spoken survives that.
  agentNames: 'mirror, espejo',
  wakeEnabled: true, // answer when addressed, not only on /mj ask

  // Transcribe each utterance moments after it's spoken, rather than doing the
  // whole buffer at the moment someone asks. Costs more (you pay for all
  // speech) but it's the difference between answering in ~2s and ~20s — and
  // it's what makes wake-phrase detection possible without a native engine.
  eagerTranscription: true,

  // Transcription
  sttProvider: 'openai', // 'openai' | 'local' (whisper.cpp on this machine)
  sttLocalModel: 'ggml-base', // whisper.cpp model; the panel suggests one per machine
  sttModel: 'whisper-1', // OpenAI transcription model: 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe'
  openaiApiKey: '',

  // Thinking
  brainProvider: 'anthropic', // 'anthropic' | 'openai'
  brainModel: '', // blank = the provider's default
  anthropicApiKey: '',

  // 'chat' answers from one API call. 'agent' runs a persistent Claude session
  // that remembers the conversation and can use tools — its own (reminders,
  // moving people around the call, web search) plus any MCP servers configured
  // below. The default, because it is what the thing is for; 'chat' is there
  // for when you want the fastest possible answer and nothing else.
  //
  // 'cascade' puts a small fast model in front of the agent: it answers what
  // needs no tools and hands the rest over. See agent/cascade.js for why it
  // decides by attempting rather than by classifying first.
  brainKind: 'agent', // 'chat' | 'agent' | 'cascade'
  // The model in front, in cascade mode. Small on purpose — its only job is to
  // recognise when it is out of its depth, and to sound like itself when it
  // isn't.
  fastModel: '',
  // MCP servers the agent may use, as a JSON object — same shape Claude
  // Desktop and Claude Code use: { "name": { "command": ..., "args": [...] } }
  // or { "name": { "type": "http", "url": ... } }.
  mcpServers: '',
  // Folders the agent may reach, one full path per line. These are what a
  // filesystem-style MCP server actually gets scoped to — see parseDirectories
  // in agent/mcp.js for why the server's own arguments don't decide it.
  agentDirectories: '',
  // How many tool-using rounds one answer may take before it's cut off. A
  // confused agent left unbounded will happily spend a minute and a dollar.
  agentMaxTurns: 8,
  // Instructions added by whoever is in the call, one per line. Appended to
  // the prompt below the fixed rules, which they cannot override — see
  // customInstructionBlock in agent/instructions.js for what that means and
  // why the split exists.
  customInstructions: '',

  // Let it look things up. Costs a second or two per answer. Both providers
  // support it: OpenAI through its search-capable models, Anthropic through a
  // server-side tool it runs itself.
  webSearch: true,

  // Speaking
  ttsProvider: 'openai', // 'openai' | 'local' (Piper, runs on this machine)
  ttsVoice: 'onyx', // OpenAI voice
  ttsModel: 'gpt-4o-mini-tts', // OpenAI speech model: 'gpt-4o-mini-tts' | 'tts-1'
  ttsSpeed: 1, // OpenAI speaking rate, 1 = the model's own pace; 1.25 is about a fifth faster
  ttsLocalVoice: 'es_ES-davefx-medium', // Piper voice

  // Where it writes down what it is playing.
  //
  // The bot plays the music itself, so this is not how the track gets queued —
  // it is how the room finds out what it queued. That matters more than it
  // sounds: a music command is carried out without saying anything, because
  // pausing the song to announce that you skipped the song is worse than
  // skipping it. This line is what replaces the spoken confirmation, and
  // written beats spoken for a title you may have misheard.
  //
  // Blank restores the default, like every non-secret setting. A server
  // without such a channel simply gets no message; the music still plays.
  musicChannel: 'music',

  // Web UI
  webPort: 3000,
};

/** Values that may also come from the environment, mapped to their env var. */
const ENV_KEYS = {
  token: 'DISCORD_TOKEN',
  guildId: 'DISCORD_GUILD_ID',
  webPort: 'WEB_PORT',
  openaiApiKey: 'OPENAI_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  bufferSeconds: 'BUFFER_SECONDS',
};

/** OpenAI's stock voices. */
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
/** OpenAI speech models: the faster one first. Measured first byte 0.4 to 1.1 s against tts-1's 0.8 to 1.5 s. */
export const TTS_MODELS = ['gpt-4o-mini-tts', 'tts-1'];
/**
 * Speaking-rate bounds. The API accepts 0.25 to 4; outside this band the
 * voice is a caricature. Measured on the same sentence, gpt-4o-mini-tts at
 * 1.0 took 6.6 s where tts-1 took 5.4, and 1.25 brought it to 5.5: the
 * newer model's own pace is the slow one, and 1.25 is what "the old pace"
 * means for it.
 */
export const TTS_SPEED_MIN = 0.8;
export const TTS_SPEED_MAX = 1.6;
export function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, n)) * 100) / 100;
}

/** whisper.cpp models, described for the panel. */
/**
 * OpenAI transcription models. whisper-1 stays the default until a week of
 * the noise guard's log shows gpt-4o-transcribe's echoes are caught: measured
 * from the server it answers in 0.7 s against whisper-1's 1.7 s, but with a
 * name prompt it answers noise with the bot's name.
 */
export const STT_API_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'];

const STT_MODELS = [
  { id: 'ggml-base', label: 'base — 142MB, quick on a CPU' },
  { id: 'ggml-small', label: 'small — 466MB, better without a GPU' },
  { id: 'ggml-large-v3-turbo', label: 'large-v3-turbo — 1.6GB, for a GPU' },
];

/** Piper voices, described for the panel. Kept here to avoid a circular import. */
const LOCAL_VOICE_INFO = [
  { id: 'es_ES-davefx-medium', label: 'Spanish (Spain) — the fastest' },
  { id: 'en_US-lessac-medium', label: 'English (US) — fast' },
  { id: 'es_AR-daniela-high', label: 'Spanish (Argentina) — Rioplatense accent, slower' },
];

const NUMERIC_KEYS = new Set(['webPort', 'bufferSeconds', 'agentMaxTurns']);
const BOOLEAN_KEYS = new Set([
  'agentEnabled',
  'eagerTranscription',
  'wakeEnabled',
  'webSearch',
]);

/**
 * Secrets are write-only from the UI: the field always renders empty, because
 * we never send the value to the browser. So a blank submission means "I didn't
 * touch this", never "erase it" — otherwise saving any unrelated setting on the
 * same card silently destroys the key.
 *
 * To actually clear one, edit data/config.json.
 */
const SECRET_KEYS = new Set(['token', 'openaiApiKey', 'anthropicApiKey']);

function coerce(key, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }
  return String(value);
}

function clampConfig(cfg) {
  const out = { ...cfg };

  out.webPort = Math.min(65535, Math.max(1, Math.round(out.webPort)));
  out.token = out.token.trim();
  out.guildId = out.guildId.trim();

  // 10s is too little to be useful context; past 10min a single transcription
  // gets slow and expensive enough to hurt.
  out.bufferSeconds = Math.min(600, Math.max(10, Math.round(out.bufferSeconds)));
  out.openaiApiKey = out.openaiApiKey.trim();
  out.anthropicApiKey = out.anthropicApiKey.trim();
  out.brainModel = out.brainModel.trim();
  out.fastModel = out.fastModel.trim();
  if (!['anthropic', 'openai'].includes(out.brainProvider)) out.brainProvider = 'anthropic';
  if (!['chat', 'agent', 'cascade'].includes(out.brainKind)) out.brainKind = 'chat';
  out.mcpServers = out.mcpServers.trim();
  out.agentDirectories = out.agentDirectories.trim();
  // A leading # is how people write a channel, not part of its name.
  out.musicChannel = out.musicChannel.trim().replace(/^#/, '');
  // One instruction per line, however they were typed or dictated. The caps
  // on length and count are enforced where there is somewhere to report them:
  // the panel's save handler and the voice tool.
  out.customInstructions = serialiseInstructions(parseInstructions(out.customInstructions));
  out.agentMaxTurns = Math.min(25, Math.max(1, Math.round(out.agentMaxTurns)));
  if (!VOICES.includes(out.ttsVoice)) out.ttsVoice = 'onyx';
  if (!TTS_MODELS.includes(out.ttsModel)) out.ttsModel = DEFAULTS.ttsModel;
  out.ttsSpeed = clampSpeed(out.ttsSpeed);
  if (!['openai', 'local'].includes(out.ttsProvider)) out.ttsProvider = 'openai';
  out.agentNames = out.agentNames.trim().toLowerCase() || DEFAULTS.agentNames;
  if (!['openai', 'local'].includes(out.sttProvider)) out.sttProvider = 'openai';
  if (!STT_MODELS.some((m) => m.id === out.sttLocalModel)) out.sttLocalModel = 'ggml-base';
  if (!STT_API_MODELS.includes(out.sttModel)) out.sttModel = DEFAULTS.sttModel;

  return out;
}

function readFileConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] ignoring unreadable ${CONFIG_PATH}: ${err.message}`);
    }
    return {};
  }
}

function build() {
  const fileConfig = readFileConfig();
  const merged = { ...DEFAULTS };

  // Precedence: data/config.json (written by the UI) > env > defaults.
  for (const key of Object.keys(DEFAULTS)) {
    const fromEnv = ENV_KEYS[key] ? coerce(key, process.env[ENV_KEYS[key]]) : undefined;
    if (fromEnv !== undefined) merged[key] = fromEnv;

    const fromFile = coerce(key, fileConfig[key]);
    if (fromFile !== undefined) merged[key] = fromFile;
  }

  return clampConfig(merged);
}

class Config extends EventEmitter {
  constructor() {
    super();
    this.values = build();
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values };
  }

  /** Config minus secrets, safe to hand to the browser. */
  publicView() {
    const { token, openaiApiKey, anthropicApiKey, ...rest } = this.values;
    return {
      ...rest,
      hasToken: Boolean(token),
      tokenPreview: previewToken(token),
      hasOpenaiApiKey: Boolean(openaiApiKey),
      openaiApiKeyPreview: previewToken(openaiApiKey),
      hasAnthropicApiKey: Boolean(anthropicApiKey),
      anthropicApiKeyPreview: previewToken(anthropicApiKey),
      voices: VOICES,
      localVoices: LOCAL_VOICE_INFO,
      sttModels: STT_MODELS,
    };
  }

  /** Merge a partial update, persist it, and notify listeners. */
  update(patch) {
    const next = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;

      // A blank secret means "unchanged", not "delete". See SECRET_KEYS.
      if (SECRET_KEYS.has(key) && typeof value === 'string' && !value.trim()) continue;

      const coerced = coerce(key, value);
      // Booleans and empty strings are meaningful clears; coerce() drops '' only.
      if (coerced !== undefined) next[key] = coerced;
      else if (!BOOLEAN_KEYS.has(key) && value === '') next[key] = DEFAULTS[key];
    }

    const previous = this.values;
    this.values = clampConfig(next);
    this.persist();
    this.emit('change', this.values, previous);
    return this.values;
  }

  persist() {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.values, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
  }
}

function previewToken(token) {
  if (!token) return '';
  // Showing head and tail of something short reveals the whole secret. Real
  // keys are far longer than this, so anything shorter is malformed anyway —
  // mask it completely rather than leak it into the browser.
  if (token.length < 16) return '•'.repeat(12);
  return `${token.slice(0, 6)}${'•'.repeat(12)}${token.slice(-4)}`;
}

export const config = new Config();
export { CONFIG_PATH, DEFAULTS, VOICES, LOCAL_VOICE_INFO };
