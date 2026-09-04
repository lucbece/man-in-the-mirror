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
    mcpServers: '',
    agentDirectories: '',
    agentMaxTurns: 8,
    customInstructions: '',
    webSearch: true,
    ttsProvider: 'openai',
    ttsVoice: 'onyx',
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
    music: music ?? { current: null, queue: [], volume: 1, paused: false, live: false },
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
  current: { title: 'A song Fede queued', requestedBy: 'Fede' },
  queue: [{ title: 'Up next, from Pato', requestedBy: 'Pato' }],
  volume: 0.6,
  paused: false,
  live: true,
};

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
  },

  // Bot online, nobody in a call yet.
  idle: {
    config: fakeConfig(),
    bot: BOT_READY,
    guilds: [GUILD],
    sessions: [],
    answers: NO_ANSWERS,
  },

  // One session, three people, the agent has been answering.
  call: {
    config: fakeConfig(),
    bot: BOT_READY,
    guilds: [GUILD],
    sessions: [fakeSession()],
    answers: ANSWER_STATS,
  },

  // Same call, plus music mode.
  music: {
    config: fakeConfig(),
    bot: BOT_READY,
    guilds: [GUILD],
    sessions: [fakeSession({ quiet: true, music: MUSIC_PLAYING })],
    answers: ANSWER_STATS,
  },
};

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
  return html.replace('<script src="app.js"></script>', `${inject}<script src="app.js"></script>`);
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
