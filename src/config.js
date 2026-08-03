import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import dotenv from 'dotenv';

import { ROOT_DIR } from './paths.js';

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const CONFIG_PATH = path.join(ROOT_DIR, 'data', 'config.json');

const DEFAULTS = {
  // Secrets / identity
  token: '',
  guildId: '', // optional: registers slash commands instantly on this guild only

  // Listening
  // Off by default. While off the bot joins self-deafened and never receives a
  // byte of audio — enabling it is an explicit, and visible, act.
  agentEnabled: false,
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
  sttProvider: 'openai', // 'openai' | 'local' (local not implemented yet)
  openaiApiKey: '',

  // Thinking
  brainProvider: 'anthropic', // 'anthropic' | 'openai'
  brainModel: '', // blank = the provider's default
  anthropicApiKey: '',

  // Let it look things up. Costs a second or two per answer. Both providers
  // support it: OpenAI through its search-capable models, Anthropic through a
  // server-side tool it runs itself.
  webSearch: true,

  // Speaking
  ttsVoice: 'onyx',
  volume: 0.6,

  // Web UI
  webPort: 3000,
};

/** Values that may also come from the environment, mapped to their env var. */
const ENV_KEYS = {
  token: 'DISCORD_TOKEN',
  guildId: 'DISCORD_GUILD_ID',
  volume: 'VOLUME',
  webPort: 'WEB_PORT',
  openaiApiKey: 'OPENAI_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  bufferSeconds: 'BUFFER_SECONDS',
};

/** OpenAI's stock voices. */
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

const NUMERIC_KEYS = new Set(['volume', 'webPort', 'bufferSeconds']);
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

  out.volume = Math.min(2, Math.max(0, out.volume));
  out.webPort = Math.min(65535, Math.max(1, Math.round(out.webPort)));
  out.token = out.token.trim();
  out.guildId = out.guildId.trim();

  // 10s is too little to be useful context; past 10min a single transcription
  // gets slow and expensive enough to hurt.
  out.bufferSeconds = Math.min(600, Math.max(10, Math.round(out.bufferSeconds)));
  out.openaiApiKey = out.openaiApiKey.trim();
  out.anthropicApiKey = out.anthropicApiKey.trim();
  out.brainModel = out.brainModel.trim();
  if (!['anthropic', 'openai'].includes(out.brainProvider)) out.brainProvider = 'anthropic';
  if (!VOICES.includes(out.ttsVoice)) out.ttsVoice = 'onyx';
  out.agentNames = out.agentNames.trim().toLowerCase() || DEFAULTS.agentNames;
  if (!['openai', 'local'].includes(out.sttProvider)) out.sttProvider = 'openai';

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
export { CONFIG_PATH, DEFAULTS };
