import { config } from './config.js';
import { bot } from './bot/index.js';
import { sessionManager } from './voice/manager.js';
import { startWebServer } from './web/server.js';
import { warmFillers } from './agent/filler.js';

async function main() {

  const server = await startWebServer();
  const port = server.address().port;
  console.log(`[app] control panel: http://localhost:${port}`);

  if (config.get('token')) {
    await bot.start();
    // Render the "hang on" clips now; the first search shouldn't wait for them.
    warmFillers()
      .then((r) => {
        if (r.rendered || r.reused) {
          console.log(
            `[filler] ${r.cached} clip(s) ready` +
              (r.rendered ? ` (${r.rendered} newly rendered)` : ' (all from cache)'),
          );
        }
      })
      .catch(() => {});
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
