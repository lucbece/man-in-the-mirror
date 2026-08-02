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

  // Playback behaviour
  minIntervalSeconds: 30,
  maxIntervalSeconds: 120,
  volume: 0.6,
  playOnJoin: true, // fire one sound right after joining instead of waiting
  pauseWhenAlone: true, // don't play to an empty channel
  autoStart: true, // start the random scheduler as soon as the bot joins

  // Web UI
  webPort: 3000,
};

/** Values that may also come from the environment, mapped to their env var. */
const ENV_KEYS = {
  token: 'DISCORD_TOKEN',
  guildId: 'DISCORD_GUILD_ID',
  minIntervalSeconds: 'MIN_INTERVAL_SECONDS',
  maxIntervalSeconds: 'MAX_INTERVAL_SECONDS',
  volume: 'VOLUME',
  webPort: 'WEB_PORT',
};

const NUMERIC_KEYS = new Set([
  'minIntervalSeconds',
  'maxIntervalSeconds',
  'volume',
  'webPort',
]);
const BOOLEAN_KEYS = new Set(['playOnJoin', 'pauseWhenAlone', 'autoStart']);

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

  out.minIntervalSeconds = Math.max(1, Math.round(out.minIntervalSeconds));
  out.maxIntervalSeconds = Math.max(1, Math.round(out.maxIntervalSeconds));
  if (out.maxIntervalSeconds < out.minIntervalSeconds) {
    // Swap rather than reject: the intent is obvious.
    [out.minIntervalSeconds, out.maxIntervalSeconds] = [
      out.maxIntervalSeconds,
      out.minIntervalSeconds,
    ];
  }

  out.volume = Math.min(2, Math.max(0, out.volume));
  out.webPort = Math.min(65535, Math.max(1, Math.round(out.webPort)));
  out.token = out.token.trim();
  out.guildId = out.guildId.trim();

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
    const { token, ...rest } = this.values;
    return { ...rest, hasToken: Boolean(token), tokenPreview: previewToken(token) };
  }

  /** Merge a partial update, persist it, and notify listeners. */
  update(patch) {
    const next = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue;
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
  return `${token.slice(0, 6)}${'•'.repeat(12)}${token.slice(-4)}`;
}

export const config = new Config();
export { CONFIG_PATH, DEFAULTS };
