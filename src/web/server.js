import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config } from '../config.js';
import { bot } from '../bot/index.js';
import { sessionManager } from '../voice/manager.js';
import { formatTranscript, transcribeBuffer } from '../agent/stt.js';
import { ask, AgentBusyError } from '../agent/index.js';
import { parseMcpServers, parseDirectories } from '../agent/mcp.js';
import { agentSessionStatus } from '../agent/agent-brain.js';

const HOST = process.env.WEB_HOST || '127.0.0.1';

export function startWebServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  app.use(express.static(publicDir));

  // --- state ---------------------------------------------------------------

  app.get('/api/state', (_req, res) => {
    res.json({
      config: config.publicView(),
      bot: bot.status(),
      guilds: bot.guildOverview(),
      sessions: sessionManager
        .status()
        .map((session) => ({ ...session, agent: agentSessionStatus(session.guildId) })),
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
      res.json(await ask(session, { question: question.trim(), askedBy: 'the control panel' }));
    } catch (err) {
      const code = err instanceof AgentBusyError ? 409 : 502;
      res.status(code).json({ error: err.message });
    }
  });

  // --- boot ----------------------------------------------------------------

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
