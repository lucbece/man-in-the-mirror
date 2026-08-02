import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config } from '../config.js';
import { SOUNDS_DIR } from '../paths.js';
import { sounds, SUPPORTED_EXTENSIONS } from '../sounds.js';
import { bot } from '../bot/index.js';
import { sessionManager } from '../voice/manager.js';

const HOST = process.env.WEB_HOST || '127.0.0.1';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

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
      sessions: sessionManager.status(),
      sounds: sounds.refresh(),
      soundsDir: SOUNDS_DIR,
      supportedExtensions: [...SUPPORTED_EXTENSIONS],
    });
  });

  // --- configuration -------------------------------------------------------

  app.post('/api/config', async (req, res) => {
    const body = req.body ?? {};
    const tokenChanged =
      typeof body.token === 'string' && body.token.trim() && body.token.trim() !== config.get('token');

    // An empty token field means "leave it alone", not "erase it".
    if (typeof body.token === 'string' && !body.token.trim()) delete body.token;

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

  app.post('/api/voice/scheduler', (req, res) => {
    const { guildId, running } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });

    if (running) session.start({ immediate: false });
    else session.stop();
    res.json(session.status());
  });

  app.post('/api/voice/play', (req, res) => {
    const { guildId, sound } = req.body ?? {};
    const session = sessionManager.get(guildId);
    if (!session) return res.status(404).json({ error: 'Not connected in that guild' });

    const file = sound ? sounds.resolve(sound) : null;
    if (sound && !file) return res.status(404).json({ error: `No sound named ${sound}` });

    const played = session.playRandom(file);
    if (!played) {
      return res.status(409).json({
        error: sounds.size === 0 ? 'No sounds available' : 'Nobody is in the channel',
      });
    }
    res.json(session.status());
  });

  // --- sound library -------------------------------------------------------

  app.put(
    '/api/sounds/:name',
    express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
    (req, res) => {
      const name = path.basename(req.params.name);
      const ext = path.extname(name).toLowerCase();

      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        return res.status(400).json({ error: `Unsupported file type: ${ext || 'none'}` });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty upload' });
      }

      fs.mkdirSync(SOUNDS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SOUNDS_DIR, name), req.body);
      sounds.refresh();
      res.json({ ok: true, name, sounds: sounds.files });
    },
  );

  app.delete('/api/sounds/:name', (req, res) => {
    const file = sounds.resolve(req.params.name);
    if (!file) return res.status(404).json({ error: 'No such sound' });
    fs.unlinkSync(file);
    sounds.refresh();
    res.json({ ok: true, sounds: sounds.files });
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
