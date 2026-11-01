import { config } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { deleteExpiredSessions } from './db/repositories/sessionsRepo.js';
import { startTelegramPoller } from './telegram/poller.js';
import { startBroadcastWorker } from './telegram/worker.js';
import { BOT_IDS } from './telegram/botIds.js';
import { createApp } from './app.js';

runMigrations();
deleteExpiredSessions();

const app = createApp();

// Prompt 0140 — pollers/worker now start ONLY inside the successful-bind
// callback, never before it. Previously they started unconditionally
// before app.listen() was even attempted, so a second instance of this
// process (e.g. a nodemon-managed dev server racing a manually-started
// one on the same port — exactly what happened in this prompt's own
// incident archive) would already have live Telegram long-poll
// connections running by the time its own `listen()` call failed with
// EADDRINUSE and crashed. This reordering makes a failed port bind a
// hard, natural mutex: an instance that can't get the port never starts
// a single poller, so it can never race a real instance's own polling —
// no separate lock file or process-detection code needed for that
// specific failure mode. `app.listen()`'s own default behavior for a bind
// failure (an unhandled 'error' event crashing the process with a loud
// stack trace) is intentionally left untouched — this fix is purely about
// ordering, not about swallowing or prettifying that failure.
app.listen(config.port, () => {
  console.log(`[backend] listening on http://localhost:${config.port} (${config.nodeEnv})`);
  // Prompt 0191 — the kill switch's CONTRACT line: any future verification
  // prompt spawning a backend MUST quote this exact line before its next
  // step (see CLAUDE.md deploy lesson 8). The switch already forced every
  // bot token to null in env.js, so the loop below would no-op anyway —
  // this line exists so "Telegram is off" is one unambiguous, greppable
  // statement instead of two per-bot "no token configured" lines that
  // look identical to an ordinary unconfigured dev machine.
  if (config.telegram.disabled) {
    console.log('[telegram] DISABLED by TELEGRAM_DISABLED=1: no poller, worker, welcome, or admin send will run in this process');
  }
  // Fire-and-forget: one independent poller loop per bot (prompt 0138) —
  // each no-ops (logged, not fatal) when that bot has no token configured,
  // so local dev never requires a real Telegram bot to run, and a real
  // token for only one of the two bots starts exactly that one poller.
  // The broadcast worker stays a single shared loop across every bot (see
  // worker.js's own header comment for why).
  for (const botId of BOT_IDS) {
    startTelegramPoller(botId);
  }
  startBroadcastWorker();
});
