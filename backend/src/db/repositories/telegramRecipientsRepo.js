/**
 * Data access for `telegram_broadcast_recipients` — the durable per-recipient
 * queue for subscriber-targeted broadcasts. A 'pending' row IS a queued job;
 * see backend/src/telegram/worker.js for the throttled drain loop.
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const insertStmt = lazyStatement(`
  INSERT INTO telegram_broadcast_recipients (id, broadcast_id, subscriber_id, chat_id, status, created_at)
  VALUES (@id, @broadcastId, @subscriberId, @chatId, 'pending', @now)
`);
const claimPendingStmt = lazyStatement(
  "SELECT * FROM telegram_broadcast_recipients WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?"
);
const markSentStmt = lazyStatement(
  "UPDATE telegram_broadcast_recipients SET status = 'sent', sent_at = ?, error_message = NULL WHERE id = ?"
);
const markFailedStmt = lazyStatement(
  "UPDATE telegram_broadcast_recipients SET status = 'failed', error_message = ? WHERE id = ?"
);
const hasPendingForBroadcastStmt = lazyStatement(
  "SELECT 1 FROM telegram_broadcast_recipients WHERE broadcast_id = ? AND status = 'pending' LIMIT 1"
);
const listFailedStmt = lazyStatement(
  "SELECT * FROM telegram_broadcast_recipients WHERE broadcast_id = ? AND status = 'failed' ORDER BY created_at ASC LIMIT ?"
);

/**
 * One row per subscriber, inserted inside a single transaction — hand-rolled
 * BEGIN/COMMIT since node:sqlite's DatabaseSync has no db.transaction()
 * helper (see db/migrate.js for the same pattern).
 */
export function bulkInsertPending(broadcastId, subscribers) {
  const now = new Date().toISOString();
  const db = getDb();
  db.exec('BEGIN');
  try {
    for (const sub of subscribers) {
      insertStmt().run({ id: randomUUID(), broadcastId, subscriberId: sub.id, chatId: sub.chat_id, now });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Global, oldest-first claim across every broadcast — see worker.js for why. */
export function claimPendingBatch(limit) {
  return claimPendingStmt().all(limit);
}

export function markSent(id) {
  markSentStmt().run(new Date().toISOString(), id);
}

export function markFailed(id, errorMessage) {
  markFailedStmt().run(errorMessage, id);
}

export function hasPendingForBroadcast(broadcastId) {
  return Boolean(hasPendingForBroadcastStmt().get(broadcastId));
}

export function listFailedForBroadcast(broadcastId, limit = 50) {
  return listFailedStmt().all(broadcastId, limit);
}
