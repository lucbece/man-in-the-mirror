import { config } from './config.js';
import { bot } from './bot/index.js';
import { sessionManager } from './voice/manager.js';
import { startWebServer } from './web/server.js';
import { warmFillers } from './agent/filler.js';
import { reminders } from './agent/reminders.js';

/**
 * How long shutdown waits for whatever is already being said to finish
 * before it goes on and tears the connections down anyway.
 *
 * AUDIT.md: without this, `leaveAll` used to run first and cut the bot off
 * mid-word on every deploy that landed mid-answer. `compose.yaml`'s
 * `stop_grace_period` has to stay comfortably ahead of this value — see the
 * fallback timer in `shutdown` below — or Docker's SIGKILL arrives before
 * the drain ever gets the chance to matter.
 */
export const SHUTDOWN_DRAIN_MS = 25_000;

async function main() {
  // Before the bot connects, so a reminder that comes due seconds after boot
  // has somewhere to fire into rather than racing the gateway.
  reminders.restore();

  const server = await startWebServer();
  const port = server.address().port;
  console.log(`[app] control panel: http://localhost:${port}`);

  // Once the gateway is up, back into the channels the last process was in.
  // On every 'ready', not only the first: a token change from the panel
  // restarts the client, and that is a restart like any other.
  bot.on('state', ({ state }) => {
    if (state !== 'ready' || !bot.client) return;
    sessionManager.rejoin(bot.client).catch((err) => console.warn(`[voice] rejoin failed: ${err.message}`));
  });

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

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      // Whoever is asking has already asked once and is not waiting for an
      // answer — a second SIGTERM from an impatient operator, or Docker's own
      // repeat. Skip straight to the fast path the whole file used to be.
      console.log(`\n[app] ${signal} again — leaving now`);
      sessionManager.leaveAll({ comingBack: true });
      await bot.stop();
      server.close();
      // Give the voice connections a beat to close cleanly.
      setTimeout(() => process.exit(0), 300).unref();
      return;
    }
    shuttingDown = true;
    console.log(`\n[app] ${signal} — shutting down`);
    // A floor under the drain below: a wedged ask() or a speech queue that
    // never reports idle must not keep the container alive past
    // compose.yaml's stop_grace_period, which Docker enforces with SIGKILL
    // regardless of what this process is doing. Armed now, from the start of
    // shutdown, not after the drain — a wedged drain is exactly the case
    // this has to cover.
    setTimeout(() => process.exit(0), SHUTDOWN_DRAIN_MS + 3_000).unref();

    // Let whatever is already being said finish before anything is torn
    // down — see AUDIT.md and SessionManager.drain(). leaveAll()'s
    // destroy() cancels speech unconditionally, so by the time it runs below
    // there should be nothing left in any session for it to cut off.
    await sessionManager.drain({ timeoutMs: SHUTDOWN_DRAIN_MS });
    // Remembered, not forgotten: the next start puts the bot back in the call.
    sessionManager.leaveAll({ comingBack: true });
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
