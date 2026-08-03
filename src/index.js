import { config } from './config.js';
import { bot } from './bot/index.js';
import { sessionManager } from './voice/manager.js';
import { startWebServer } from './web/server.js';

async function main() {

  const server = await startWebServer();
  const port = server.address().port;
  console.log(`[app] control panel: http://localhost:${port}`);

  if (config.get('token')) {
    await bot.start();
  } else {
    console.log('[app] no token configured — open the control panel to add one');
  }

  const shutdown = async (signal) => {
    console.log(`\n[app] ${signal} — shutting down`);
    sessionManager.leaveAll();
    await bot.stop();
    server.close();
    // Give the voice connections a beat to close cleanly.
    setTimeout(() => process.exit(0), 300).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[app] fatal:', err);
  process.exit(1);
});
