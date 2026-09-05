import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config, VOICES, LOCAL_VOICE_INFO, TTS_MODELS, clampSpeed } from '../config.js';
import { bot } from '../bot/index.js';
import { sessionManager } from '../voice/manager.js';
import { formatTranscript, transcribeBuffer } from '../agent/stt.js';
import { ask, AgentBusyError } from '../agent/index.js';
import { parseMcpServers, parseDirectories } from '../agent/mcp.js';
import {
  MAX_INSTRUCTIONS,
  MAX_INSTRUCTION_CHARS,
  parseInstructions,
  renderInstruction,
} from '../agent/instructions.js';
import { agentSessionStatus } from '../agent/agent-brain.js';
import { answerStats } from '../agent/answers.js';
import { MODELS } from '../agent/models.js';
import { createTts } from '../agent/tts.js';
import { isPiperInstalled } from '../agent/piper.js';
import { sameOriginOnly } from './same-origin.js';

const HOST = process.env.WEB_HOST || '127.0.0.1';

/** The one sentence every voice preview says, so voices are comparable. */
const PREVIEW_TEXT = 'Hola, soy el espejo. This is how I sound.';

/** Actions the panel's music strip can send straight to the session's player. */
const MUSIC_ACTIONS = new Set(['play', 'skip', 'pause', 'resume', 'stop']);

/**
 * The panel, as an express app that is not listening yet.
 *
 * Split from `startWebServer` so the routes can be exercised on an ephemeral
 * port without a Discord connection or the configured port. Nothing tested
 * this file before, and the CSRF hole below is exactly what a couple of
 * requests would have caught.
 */
export function createApp(deps = {}) {
  // Injectable purely so the voice-preview route can be tested without a
  // network call or a Piper binary — every other route here still uses the
  // real collaborators, the same shape ask() takes its own deps in.
  const {
    createTts: makeTts = createTts,
    isPiperInstalled: piperInstalled = isPiperInstalled,
  } = deps;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use(express.static(publicDir));

  // Before every route, and covering all of them: nothing here should act on
  // a request that some other page in the browser made.
  app.use(sameOriginOnly);

  // --- state ---------------------------------------------------------------

  app.get('/api/state', (_req, res) => {
    res.json({
      config: config.publicView(),
      bot: bot.status(),
      guilds: bot.guildOverview(),
      sessions: sessionManager
        .status()
        .map((session) => ({ ...session, agent: agentSessionStatus(session.guildId) })),
      answers: answerStats(),
      models: MODELS,
    });
  });

  // --- configuration -------------------------------------------------------

  app.post('/api/config', async (req, res) => {
    const body = req.body ?? {};

    // Reject broken MCP JSON at save time, with the field named — finding out
    // at the first question, mid-conversation, is the worst possible moment.
    if (typeof body.mcpServers === 'string' && body.mcpServers.trim()) {
      try {
        parseMcpServers(body.mcpServers);
      } catch (err) {
        return res.status(400).json({ ok: false, error: `MCP servers: ${err.message}` });
      }
    }

    // A folder that doesn't exist is a typo, and the agent would just report
    // an empty world rather than anything that points at the mistake.
    if (typeof body.agentDirectories === 'string' && body.agentDirectories.trim()) {
      try {
        parseDirectories(body.agentDirectories, {
          exists: (dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
        });
      } catch (err) {
        return res.status(400).json({ ok: false, error: `Folders: ${err.message}` });
      }
    }

    // Same limits the voice tool enforces, so the two ways in cannot disagree
    // about what the bot is currently being told.
    if (typeof body.customInstructions === 'string' && body.customInstructions.trim()) {
      // Measured as the room hears it, with person tokens rendered to names:
      // the same rule the voice path applies, so an instruction the bot saved
      // itself can never be refused here for being a few characters longer
      // on disk than it is out loud.
      const list = parseInstructions(body.customInstructions).map((line) => renderInstruction(line));
      const long = list.find((line) => line.length > MAX_INSTRUCTION_CHARS);
      if (long) {
        return res.status(400).json({
          ok: false,
          error: `Instructions: one line is ${long.length} characters; keep each under ${MAX_INSTRUCTION_CHARS}.`,
        });
      }
      if (list.length > MAX_INSTRUCTIONS) {
        return res.status(400).json({
          ok: false,
          error: `Instructions: ${list.length} lines, and ${MAX_INSTRUCTIONS} is the limit.`,
        });
      }
    }

    const tokenChanged =
      typeof body.token === 'string' && body.token.trim() && body.token.trim() !== config.get('token');

    const guildChanged =
      typeof body.guildId === 'string' && body.guildId.trim() !== config.get('guildId');

    config.update(body);

    let restarted = false;
    if (tokenChanged || (guildChanged && bot.isRunning)) {
      restarted = true;
      bot.restart().catch((err) => console.error('[web] restart failed:', err.message));
    }

    res.json({ ok: true, restarted, config: config.publicView() });
  });

  // --- bot lifecycle -------------------------------------------------------

  app.post('/api/bot/:action', async (req, res) => {
    const { action } = req.params;
    try {
      if (action === 'start') return res.json(await bot.start());
      if (action === 'stop') return res.json(await bot.stop());
      if (action === 'restart') return res.json(await bot.restart());
      return res.status(400).json({ error: `Unknown action: ${action}` });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // --- voice ---------------------------------------------------------------

  app.post('/api/voice/join', async (req, res) => {
    const { guildId, channelId } = req.body ?? {};
    if (!guildId || !channelId) {
      return res.status(400).json({ error: 'guildId and channelId are required' });
    }
    if (!bot.client) return res.status(409).json({ error: 'Bot is not running' });

    try {
      const guild = await bot.client.guilds.fetch(guildId);
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isVoiceBased()) {
        return res.status(400).json({ error: 'That channel is not a voice channel' });
      }
      const session = await sessionManager.join(channel);
      return res.json(session.status());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/voice/leave', (req, res) => {
    const { guildId } = req.body ?? {};
    res.json({ ok: sessionManager.leave(guildId) });
  });

  app.post('/api/voice/listen', async (req, res) => {
    const { guildId, listening } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });

    try {
      config.update({ agentEnabled: Boolean(listening) });
      await session.setAgentEnabled(Boolean(listening));
      res.json(session.status());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/voice/shush', (req, res) => {
    const { guildId } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });
    session.shush();
    res.json(session.status());
  });

  app.post('/api/voice/quiet', (req, res) => {
    const { guildId, quiet } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });
    // Not written to the config on the way past, unlike listening: music mode
    // belongs to this session and this song, and a bot that came back from a
    // restart still mute would look broken.
    session.setQuiet(Boolean(quiet));
    res.json(session.status());
  });

  app.post('/api/voice/transcript', async (req, res) => {
    const { guildId } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });
    if (!session.agentEnabled) return res.status(409).json({ error: 'Not listening' });

    try {
      const result = await transcribeBuffer(session.receiver.buffer);
      res.json({
        ...result,
        transcript: formatTranscript(session.receiver.buffer.recent()),
        stats: session.receiver.buffer.stats(),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/voice/ask', async (req, res) => {
    const { guildId, question } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });
    if (!question?.trim()) return res.status(400).json({ error: 'question is required' });

    try {
      // Named as a person, not as a surface. Called "the control panel" the
      // model read the question as a test of itself and refused things it
      // does for anyone in the call — measured: the same request escalated 4
      // times out of 4 when the asker had a name, and was refused when it did
      // not. Still no askedById, so anything permission-checked correctly
      // declines to guess who this is.
      res.json(
        await ask(session, { question: question.trim(), askedBy: 'the person running the bot' }),
      );
    } catch (err) {
      const code = err instanceof AgentBusyError ? 409 : 502;
      res.status(code).json({ error: err.message });
    }
  });

  // The same player the /mj music slash commands drive (see bot/commands.js),
  // reached from the panel's music strip instead of a Discord command.
  app.post('/api/voice/music/:action', async (req, res) => {
    const { action } = req.params;
    if (!MUSIC_ACTIONS.has(action)) {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }
    const { guildId, query } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });

    try {
      if (action === 'play') {
        if (!query?.trim()) return res.status(400).json({ error: 'query is required' });
        // "the control panel" rather than a person's name: nobody in
        // particular asked for this, the same reasoning /api/voice/ask uses.
        await session.music.add(query.trim(), 'the control panel');
      } else {
        // skip, pause, resume, stop — MUSIC_ACTIONS is exactly the set of
        // MusicPlayer method names that take no argument, so this is the
        // whole dispatch.
        session.music[action]();
      }
      res.json({ music: session.music.status() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- speaking --------------------------------------------------------------

  /**
   * One clip per provider+voice, kept for the life of the process — a "Hear
   * it" button clicked twice should not pay for synthesis twice, and nothing
   * about a voice's sample changes while the bot is running.
   */
  const previewCache = new Map();

  app.get('/api/tts/preview', async (req, res) => {
    const provider = String(req.query.provider ?? '');
    const voice = String(req.query.voice ?? '');
    if (!['openai', 'local'].includes(provider)) {
      return res.status(400).json({ error: 'provider must be "openai" or "local"' });
    }
    const knownVoice =
      provider === 'openai' ? VOICES.includes(voice) : LOCAL_VOICE_INFO.some((v) => v.id === voice);
    if (!knownVoice) return res.status(400).json({ error: `Unknown voice: ${voice}` });

    const model = String(req.query.model ?? '') || config.get('ttsModel');
    if (provider === 'openai' && !TTS_MODELS.includes(model)) {
      return res.status(400).json({ error: `Unknown speech model: ${model}` });
    }
    const speed = req.query.speed === undefined ? config.get('ttsSpeed') : clampSpeed(req.query.speed);
    const cacheKey = `${provider}:${voice}:${model}:${speed}`;
    const cached = previewCache.get(cacheKey);
    if (cached) {
      res.set('Content-Type', cached.contentType);
      return res.send(cached.buffer);
    }

    // Checked before synthesising rather than left to fail inside it: Piper's
    // binary is a multi-megabyte download, and a "Hear it" click should never
    // quietly start one — that download already happens the first time the
    // bot actually speaks locally.
    if (provider === 'local' && !piperInstalled()) {
      return res.status(503).json({ error: 'Piper is not installed on this machine.' });
    }

    try {
      const tts = makeTts({ provider, voice, model, speed });
      const buffer = await tts.synthesize(PREVIEW_TEXT);
      // Both providers hand back Ogg Opus for this call — OpenAI's `opus`
      // response format, Piper re-encoded the same way in agent/piper.js —
      // so this is exactly what the synthesiser produced, untranscoded.
      const contentType = 'audio/ogg';
      previewCache.set(cacheKey, { buffer, contentType });
      res.set('Content-Type', contentType);
      res.send(buffer);
    } catch (err) {
      // Missing OpenAI key throws here, from OpenAiTts's constructor — same
      // "unavailable" story as Piper missing, so it gets the same status.
      res.status(503).json({ error: err.message });
    }
  });

  return app;
}

export function startWebServer() {
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(config.get('webPort'), HOST);
    server.once('listening', () => resolve(server));
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${config.get('webPort')} is already in use.`));
      } else reject(err);
    });
  });
}
