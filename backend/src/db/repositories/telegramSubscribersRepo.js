/**
 * Data access for `telegram_subscribers` — everyone who has /start-ed a
 * bot. Only Telegram-platform identifiers (chat id, username, first name)
 * are ever stored here, never anything wallet-related.
 *
 * Prompt 0138 (dual-bot foundation) — every query is now scoped by bot_id,
 * and the UNIQUE constraint this table enforces changed from a bare
 * chat_id to (bot_id, chat_id): the SAME Telegram chat can legitimately
 * /start both bots independently. Row `id` (a UUID) stays the sole
 * identifier for functions that operate on an already-resolved row
 * (findSubscriberById, deactivateSubscriber, recordWelcomeSent) — no bot_id
 * needed there, since a UUID is already globally unique across bots.
 */
import { randomUUID } from 'node:crypto';
import { lazyStatement } from '../client.js';

// `source` (prompt 0233, ad attribution) is INSERT-only by design: the ON
// CONFLICT branch deliberately never references it, so a subscriber's
// source is set exactly once — at their very first /start — and an
// existing organic subscriber who later taps an ad deep link stays
// organic (undercounts ads, never overcounts). See migration 0026.
const upsertStmt = lazyStatement(`
  INSERT INTO telegram_subscribers
    (id, bot_id, chat_id, username, first_name, source, is_active, started_at, last_interaction_at, created_at, updated_at)
  VALUES
    (@id, @botId, @chatId, @username, @firstName, @source, 1, @now, @now, @now, @now)
  ON CONFLICT(bot_id, chat_id) DO UPDATE SET
    is_active = 1,
    username = excluded.username,
    first_name = excluded.first_name,
    last_interaction_at = excluded.last_interaction_at,
    updated_at = excluded.updated_at
`);
const findByChatIdStmt = lazyStatement('SELECT * FROM telegram_subscribers WHERE bot_id = ? AND chat_id = ?');
const findByIdStmt = lazyStatement('SELECT * FROM telegram_subscribers WHERE id = ?');
// Prompt 0234 (P3) — `id ASC` tie break added so the send order is FULLY
// deterministic even for two subscribers sharing one started_at: the
// recurring-round resume cursor (telegramRecurringRoundsRepo.js) depends on
// this exact order to never skip and never double a subscriber.
const listActiveStmt = lazyStatement('SELECT * FROM telegram_subscribers WHERE bot_id = ? AND is_active = 1 ORDER BY started_at ASC, id ASC');
const countActiveStmt = lazyStatement('SELECT COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND is_active = 1');
const countActiveBySourceStmt = lazyStatement(
  'SELECT source, COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND is_active = 1 GROUP BY source ORDER BY count DESC'
);
// Prompt 0235 — aggregate-only growth/attrition counts for the admin
// Dashboard/Analytics (never a chat id, same stance as everything here).
const countNewSinceStmt = lazyStatement(
  'SELECT COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND started_at >= ?'
);
const countNewBetweenStmt = lazyStatement(
  'SELECT COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND started_at >= ? AND started_at < ?'
);
const countFromAdsStmt = lazyStatement(
  'SELECT COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND source IS NOT NULL'
);
// For an is_active = 0 row, updated_at was last written by
// deactivateSubscriber() (the only writer that leaves it inactive), so it
// approximates WHEN the block was detected — an honest approximation the
// admin card's own caveat states, not a dedicated timestamp column.
const countUnsubscribedSinceStmt = lazyStatement(
  'SELECT COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND is_active = 0 AND updated_at >= ?'
);
const dailyNewStmt = lazyStatement(
  'SELECT substr(started_at, 1, 10) AS day, COUNT(*) AS count FROM telegram_subscribers WHERE bot_id = ? AND started_at >= ? GROUP BY day ORDER BY day ASC'
);
const deactivateStmt = lazyStatement('UPDATE telegram_subscribers SET is_active = 0, updated_at = ? WHERE id = ?');
const recordWelcomeSentStmt = lazyStatement(
  'UPDATE telegram_subscribers SET last_welcomed_update_id = ?, updated_at = ? WHERE id = ?'
);

/**
 * Called when a /start message arrives for a given bot. Idempotent —
 * re-starting the same bot just refreshes the row and reactivates it.
 * `source` (optional, prompt 0233) is the validated /start deep-link
 * payload; only ever applied on the INSERT branch (see upsertStmt's own
 * comment), so passing one for an existing subscriber changes nothing.
 */
export function upsertFromStart({ botId, chatId, username, firstName, source }) {
  const now = new Date().toISOString();
  upsertStmt().run({
    id: randomUUID(),
    botId,
    chatId,
    username: username ?? null,
    firstName: firstName ?? null,
    source: source ?? null,
    now
  });
  return findByChatIdStmt().get(botId, chatId);
}

/**
 * Read-only counterpart to upsertFromStart() — added in the poller's own
 * dry-run fix (see poller.js's pollOnce()) so an injected/verification
 * call can resolve a subscriber's REAL current dedup state (chat_id,
 * last_welcomed_update_id) to correctly decide whether to send, without
 * ever writing anything. Returns null if this chat has never actually
 * /start-ed this bot for real — the caller falls back to an in-memory-only
 * shape in that case (see pollOnce's own comment), never inserting a real
 * row on its behalf.
 */
export function findSubscriberByChatId(botId, chatId) {
  return findByChatIdStmt().get(botId, chatId) ?? null;
}

export function listActiveSubscribers(botId) {
  return listActiveStmt().all(botId);
}

export function countActiveSubscribers(botId) {
  return countActiveStmt().get(botId).count;
}

/**
 * Aggregate-only breakdown of active subscribers by acquisition source
 * (prompt 0233 — the admin Analytics "Subscribers by source" card). Rows
 * are `{ source, count }` with `source` null for organic subscribers —
 * never a chat id or any per-subscriber field, keeping the same
 * aggregate-only stance analyticsEventsRepo.js already holds.
 */
export function countActiveSubscribersBySource(botId) {
  return countActiveBySourceStmt().all(botId);
}

/** Prompt 0235 — subscribers whose FIRST /start is at or after `sinceIso`. */
export function countNewSubscribersSince(botId, sinceIso) {
  return countNewSinceStmt().get(botId, sinceIso).count;
}

export function countNewSubscribersBetween(botId, fromIso, toIso) {
  return countNewBetweenStmt().get(botId, fromIso, toIso).count;
}

/** Subscribers attributed to a /start deep link (source non NULL) — see prompt 0233. */
export function countSubscribersFromAds(botId) {
  return countFromAdsStmt().get(botId).count;
}

/** Inactive subscribers whose deactivation (approximated by updated_at — see the statement's own comment) falls at or after `sinceIso`. */
export function countUnsubscribedSince(botId, sinceIso) {
  return countUnsubscribedSinceStmt().get(botId, sinceIso).count;
}

/** `{ day: 'YYYY-MM-DD', count }` rows (UTC days, from started_at) since `sinceIso` — the caller zero-fills the window. */
export function dailyNewSubscribers(botId, sinceIso) {
  return dailyNewStmt().all(botId, sinceIso);
}

export function findSubscriberById(id) {
  return findByIdStmt().get(id) ?? null;
}

/** Called by the broadcast worker when Telegram reports 403 (bot blocked/kicked) for this subscriber's chat. */
export function deactivateSubscriber(id) {
  deactivateStmt().run(new Date().toISOString(), id);
}

/**
 * Called by the poller (prompt 0135) once a /start welcome reply has
 * actually been sent successfully — never on failure, so a genuinely
 * failed send (see poller.js's own try/catch around this) leaves the
 * column exactly as it was, matching the same "don't advance the
 * last-success marker on failure" pattern telegramBroadcastsRepo.js's
 * recordRecurringSend() already uses.
 */
export function recordWelcomeSent(id, updateId) {
  recordWelcomeSentStmt().run(updateId, new Date().toISOString(), id);
}
