/**
 * Data access for `telegram_recurring_rounds` (prompt 0234, P3) — one row
 * per attempted round of a recurring broadcast. The worker resumes an OPEN
 * round (finished_at NULL) from its cursor instead of re-sending from
 * scratch; see migration 0027's own header for the incident this closes
 * and why the cursor is a (started_at, subscriber id) PAIR.
 *
 * Only ever holds campaign bookkeeping — a cursor references a subscriber
 * row's own started_at/id, never a chat id or any content.
 */
import { randomUUID } from 'node:crypto';
import { lazyStatement } from '../client.js';

const findOpenStmt = lazyStatement(
  'SELECT * FROM telegram_recurring_rounds WHERE broadcast_id = ? AND finished_at IS NULL ORDER BY round_no DESC LIMIT 1'
);
const findLastFinishedStmt = lazyStatement(
  'SELECT * FROM telegram_recurring_rounds WHERE broadcast_id = ? AND finished_at IS NOT NULL ORDER BY round_no DESC LIMIT 1'
);
const nextRoundNoStmt = lazyStatement(
  'SELECT COALESCE(MAX(round_no), 0) + 1 AS next FROM telegram_recurring_rounds WHERE broadcast_id = ?'
);
const insertStmt = lazyStatement(`
  INSERT INTO telegram_recurring_rounds (id, broadcast_id, round_no, started_at, sent_count, failed_count)
  VALUES (@id, @broadcastId, @roundNo, @startedAt, 0, 0)
`);
const updateProgressStmt = lazyStatement(`
  UPDATE telegram_recurring_rounds
  SET cursor_started_at = @cursorStartedAt, cursor_subscriber_id = @cursorSubscriberId,
      sent_count = @sentCount, failed_count = @failedCount, resume_skip_json = @resumeSkipJson
  WHERE id = @id
`);
const finishStmt = lazyStatement(
  'UPDATE telegram_recurring_rounds SET finished_at = ?, sent_count = ?, failed_count = ? WHERE id = ?'
);
const resetStartStmt = lazyStatement('UPDATE telegram_recurring_rounds SET started_at = ? WHERE id = ?');

/** The one still-open (interrupted or in-flight) round for this broadcast, or null. */
export function findOpenRound(broadcastId) {
  return findOpenStmt().get(broadcastId) ?? null;
}

/** The most recently FINISHED round — what History's "Last round" duration/counts read (P4). */
export function findLastFinishedRound(broadcastId) {
  return findLastFinishedStmt().get(broadcastId) ?? null;
}

export function createRound(broadcastId, startedAtIso) {
  const id = randomUUID();
  insertStmt().run({ id, broadcastId, roundNo: nextRoundNoStmt().get(broadcastId).next, startedAt: startedAtIso });
  return findOpenStmt().get(broadcastId);
}

/**
 * Persists how far this round has provably gotten — called as the
 * contiguous attempted prefix advances (see worker.js), so a transport
 * error, a worker restart, or a deactivation can never lose more than the
 * sends that were genuinely in flight at that moment.
 */
export function updateRoundProgress(id, { cursorStartedAt, cursorSubscriberId, sentCount, failedCount, resumeSkipIds = null }) {
  updateProgressStmt().run({
    id,
    cursorStartedAt,
    cursorSubscriberId,
    sentCount,
    failedCount,
    // ids delivered BEYOND the cursor when a parallel round was interrupted
    // (at most concurrency minus one) — see migration 0027's own header.
    resumeSkipJson: resumeSkipIds && resumeSkipIds.length > 0 ? JSON.stringify(resumeSkipIds) : null
  });
}

/** The ids a resumed round must NOT re-send even though they sit past the cursor. */
export function parseResumeSkipIds(round) {
  try {
    return new Set(JSON.parse(round?.resume_skip_json || '[]'));
  } catch {
    return new Set();
  }
}

export function finishRound(id, finishedAtIso, sentCount, failedCount) {
  finishStmt().run(finishedAtIso, sentCount, failedCount, id);
}

/**
 * A cursor-less open round being retried at a LATER slot restarts its own
 * clock — nothing was delivered, so the fresh attempt's duration should
 * measure the fresh attempt, not the wait (see worker.js's due gating).
 */
export function resetRoundStart(id, startedAtIso) {
  resetStartStmt().run(startedAtIso, id);
}
