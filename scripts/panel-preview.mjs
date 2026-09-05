#!/usr/bin/env node
/**
 * Serves the panel's static files against a fake `/api/state`, so the panel
 * can be looked at — and screenshotted, see `panel-shots.sh` — without a
 * Discord token, an OpenAI or Anthropic key, or a real voice session.
 *
 * Deliberately not the real `express` app: no dependency, no bot, no config
 * file on disk. Every shape below is copied by hand from what the real
 * `/api/state` sends — `src/web/server.js`, `config.publicView()`,
 * `bot.status()`, `session.status()` plus `agentSessionStatus()`, and
 * `answerStats()` — and `test/panel-preview.test.js` checks the config keys
 * stay in sync with the real ones.
 *
 * Names throughout are placeholders (Vero, Fede, Pato, Nico; the server "Los
 * Pibes"; channels "General" and "stellar-stream") and ids are short
 * ("1", "2") — never anything that could pass for a real Discord handle.
 */
import { MODELS } from '../src/agent/models.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'src', 'web', 'public');

// Copied from src/config.js: not secrets, just the panel's fixed option
// lists, and they don't change across scenarios.
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const LOCAL_VOICES = [
  { id: 'es_ES-davefx-medium', label: 'Spanish (Spain) — the fastest' },
  { id: 'en_US-lessac-medium', label: 'English (US) — fast' },
  { id: 'es_AR-daniela-high', label: 'Spanish (Argentina) — Rioplatense accent, slower' },
];
const STT_MODELS = [
  { id: 'ggml-base', label: 'base — 142MB, quick on a CPU' },
  { id: 'ggml-small', label: 'small — 466MB, better without a GPU' },
  { id: 'ggml-large-v3-turbo', label: 'large-v3-turbo — 1.6GB, for a GPU' },
];

/** Every key `config.publicView()` sends, with sensible defaults. */
function fakeConfig(overrides = {}) {
  return {
    guildId: '1',
    agentEnabled: true,
    bufferSeconds: 90,
    agentNames: 'mirror, espejo',
    wakeEnabled: true,
    eagerTranscription: true,
    sttProvider: 'openai',
    sttLocalModel: 'ggml-base',
    brainProvider: 'anthropic',
    brainModel: '',
    brainKind: 'agent',
    fastModel: '',
    mcpServers: JSON.stringify(
      {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        search: { url: 'https://example.com/mcp' },
      },
      null,
      2,
    ),
    agentDirectories: '',
    agentMaxTurns: 8,
    customInstructions: [
      'Cuando alguien diga "la concha de tu madre", responder "y la tuya con vinagre"',
      'A <@111|Vero> decirle "tía Vero"',
      'Los jueves jugamos DayZ; el server es eu-3',
    ].join('\n'),
    webSearch: true,
    ttsProvider: 'openai',
    ttsVoice: 'onyx',
    ttsModel: 'gpt-4o-mini-tts',
    ttsLocalVoice: 'es_ES-davefx-medium',
    musicChannel: 'music',
    webPort: 3000,
    hasToken: true,
    tokenPreview: 'abcdef••••••••••••wxyz',
    hasOpenaiApiKey: true,
    openaiApiKeyPreview: 'sk-abc••••••••••••9f3k',
    hasAnthropicApiKey: true,
    anthropicApiKeyPreview: 'sk-ant••••••••••••7h2m',
    voices: VOICES,
    localVoices: LOCAL_VOICES,
    sttModels: STT_MODELS,
    ...overrides,
  };
}

const GUILD = {
  id: '1',
  name: 'Los Pibes',
  channels: [
    { id: '1', name: 'General', members: 2 },
    { id: '2', name: 'stellar-stream', members: 3 },
  ],
};

const BOT_STOPPED_NO_TOKEN = {
  state: 'stopped',
  error: 'No bot token configured.',
  user: null,
  guildCount: 0,
};

const BOT_READY = {
  state: 'ready',
  error: null,
  user: { id: '9', tag: 'man-in-the-mirror' },
  guildCount: 1,
  applicationId: '9',
  inviteUrl:
    'https://discord.com/oauth2/authorize?client_id=9&scope=bot%20applications.commands&permissions=21496832',
};

/** One voice session, shaped like `session.status()` plus the `agent` field the server adds. */
function fakeSession({ quiet = false, music = null } = {}) {
  return {
    guildId: '1',
    guildName: 'Los Pibes',
    channelId: '2',
    channelName: 'stellar-stream',
    listeners: 3,
    speaking: false,
    quiet,
    agentEnabled: true,
    listening: {
      listening: true,
      speakingNow: 1,
      utterances: 6,
      speakers: 3,
      speechSeconds: 48,
      pendingUtterances: 0,
      bytes: 184320,
      windowSeconds: 90,
    },
    eager: { queued: 0, running: false, completed: 14, failures: 0, error: null },
    agentNames: 'mirror, espejo',
    wakeEnabled: true,
    music: music ?? { playing: false, paused: false, title: null, queued: 0, volume: 1 },
    recent: RECENT,
    agent: {
      model: 'claude-sonnet-4-5',
      ageMs: 340000,
      idleMs: 4200,
      answers: 6,
      spentUsd: 0.18,
      answering: false,
      tools: ['reminders', 'web_search'],
    },
  };
}

const NO_ANSWERS = { count: 0 };

const ANSWER_STATS = {
  count: 14,
  toolRate: 0.36,
  escalationRate: 0.07,
  followUpRate: 0.14,
  firstAudioMs: 1800,
  beforeAskMs: 900,
  firstAudioWithToolsMs: 3200,
  firstAudioWithoutToolsMs: 1500,
  totalMs: 4100,
  tools: [
    { name: 'reminders', times: 3 },
    { name: 'web_search', times: 2 },
  ],
};

const MUSIC_PLAYING = {
  playing: true,
  paused: false,
  title: 'Alfredo Casero - Las Uvas',
  queued: 2,
  volume: 0.2,
};

/** The last exchanges of the call, newest last, as `session.recordExchange` keeps them. */
const RECENT = [
  {
    askedBy: 'Fede',
    question: 'Espejo, poné Las Uvas de Alfredo Casero',
    answer: 'Listo.',
    firstAudioMs: 2400,
    totalMs: 5100,
    at: '2026-09-04T18:31:12.000Z',
  },
  {
    askedBy: 'Vero',
    question: 'Espejo, ¿cuánto tardás en responder?',
    answer: 'No tengo forma de medir el tiempo real que tardo en responder ni de cronometrarlo mientras hablamos.',
    firstAudioMs: 3700,
    totalMs: 5300,
    at: '2026-09-04T18:36:05.000Z',
  },
];

/** The four scenarios `--scenario=` picks between. Exported for the test. */
export const scenarios = {
  // No keys at all: the first-run card shows.
  setup: {
    config: fakeConfig({
      guildId: '',
      hasToken: false,
      tokenPreview: '',
      hasOpenaiApiKey: false,
      openaiApiKeyPreview: '',
      hasAnthropicApiKey: false,
      anthropicApiKeyPreview: '',
    }),
    bot: BOT_STOPPED_NO_TOKEN,
    guilds: [],
    sessions: [],
    answers: NO_ANSWERS,
    models: MODELS,
  },

  // Bot online, nobody in a call yet.
  idle: {
    config: fakeConfig(),
    bot: BOT_READY,
    guilds: [GUILD],
    sessions: [],
    answers: NO_ANSWERS,
    models: MODELS,
  },

  // One session, three people, the agent has been answering.
  call: {
    config: fakeConfig(),
    bot: BOT_READY,
    guilds: [GUILD],
    sessions: [fakeSession()],
    answers: ANSWER_STATS,
    models: MODELS,
  },

  // Same call, plus music mode.
  music: {
    config: fakeConfig(),
    bot: BOT_READY,
    guilds: [GUILD],
    sessions: [fakeSession({ quiet: true, music: MUSIC_PLAYING })],
    answers: ANSWER_STATS,
    models: MODELS,
  },
};

/**
 * A short sine-wave WAV, so the Speaking section's "Hear it" button has
 * something to play without an OpenAI key or Piper installed. 16-bit PCM,
 * mono, 16 kHz — the header is 44 bytes, written by hand rather than
 * pulled in as a dependency this script otherwise has none of.
 */
function previewWav() {
  const sampleRate = 16000;
  const seconds = 0.6;
  const frequency = 440;
  const numSamples = Math.round(sampleRate * seconds);
  const fadeSamples = Math.round(sampleRate * 0.01); // 10 ms fade in/out
  const dataSize = numSamples * 2; // 16-bit mono

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const fade = Math.min(1, i / fadeSamples, (numSamples - 1 - i) / fadeSamples);
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * fade;
    buffer.writeInt16LE(Math.round(sample * 32767 * 0.8), 44 + i * 2);
  }
  return buffer;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
}

function parseArgs(argv) {
  const args = { scenario: 'call', port: 4321 };
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    const value = rest.join('=');
    if (key === 'scenario' && value) args.scenario = value;
    if (key === 'port' && value) args.port = Number(value);
  }
  return args;
}

/** `index.html`, with `<script>localStorage.setItem('mitm.tab', …)</script>` injected when asked. */
function renderIndex(tabParam) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const tab = (tabParam ?? '').match(/^[a-z-]+$/) ? tabParam : null;
  if (!tab) return html;

  const inject = `<script>localStorage.setItem('mitm.tab', ${JSON.stringify(tab)})</script>\n    `;
  return html.replace('<script type="module" src="panel/app.js"></script>', `${inject}<script type="module" src="panel/app.js"></script>`);
}

function serveStatic(res, pathname) {
  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': mimeType(filePath) });
    res.end(data);
  });
}

/** Build the request handler for one fixed scenario. */
export function createServer(scenarioName) {
  const state = scenarios[scenarioName];
  if (!state) {
    throw new Error(`Unknown scenario: ${scenarioName}. Known: ${Object.keys(scenarios).join(', ')}`);
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    if (url.pathname === '/api/tts/preview') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(previewWav());
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      // Drain the body before responding — nothing here reads it, but an
      // unconsumed request body can leave the connection hanging.
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderIndex(url.searchParams.get('tab')));
      return;
    }

    serveStatic(res, url.pathname);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const server = createServer(args.scenario);

  server.listen(args.port, '127.0.0.1', () => {
    console.log(`Panel preview (${args.scenario}) → http://127.0.0.1:${args.port}/`);
  });
}
