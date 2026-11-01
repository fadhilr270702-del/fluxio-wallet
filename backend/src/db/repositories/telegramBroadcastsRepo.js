/**
 * Data access for `telegram_broadcasts` — one row per compose-and-send
 * action. `error_message` here is reserved for channel-target failures
 * (a single synchronous send); per-recipient failures for subscriber-target
 * broadcasts live in telegramRecipientsRepo instead.
 *
 * Prompt 0138 (dual-bot foundation) — every row now carries its own bot_id.
 * Most functions here still operate by the row's own `id` (a UUID, already
 * globally unique across bots) and need no bot_id parameter at all — per
 * this prompt's "derive bot context from the existing row wherever
 * possible" principle. Only the two functions with no existing row to
 * derive bot_id from — createBroadcast (nothing exists yet) and
 * findActiveRecurringBroadcast/listBroadcasts (a "which broadcasts" query,
 * not a single-row lookup) — take an explicit botId. findDueScheduledBroadcasts
 * deliberately stays UNSCOPED (spans every bot in one query): the worker's
 * own activateDueScheduled() resolves each returned row's correct Telegram
 * client from that row's own bot_id, so there's no need to loop this query
 * once per active bot.
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const findByIdStmt = lazyStatement('SELECT * FROM telegram_broadcasts WHERE id = ?');
const insertStmt = lazyStatement(`
  INSERT INTO telegram_broadcasts
    (id, bot_id, title, title_format, body, media_url, media_file_id, media_server_filename, media_type, target_type, target_channel_id, status, scheduled_at, total_count, sent_count, failed_count, buttons, body_format, is_recurring, recurring_interval_hours, recurring_starts_at, created_by, created_at, updated_at)
  VALUES
    (@id, @botId, @title, @titleFormat, @body, @mediaUrl, @mediaFileId, @mediaServerFilename, @mediaType, @targetType, @targetChannelId, @status, @scheduledAt, @totalCount, 0, 0, @buttons, @bodyFormat, @isRecurring, @recurringIntervalHours, @recurringStartsAt, @createdBy, @now, @now)
`);
const setStatusStmt = lazyStatement('UPDATE telegram_broadcasts SET status = ?, updated_at = ? WHERE id = ?');
// Prompt 0134 — at most one recurring broadcast may be active at a time,
// enforced server-side by checking this before both (a) activating a new
// one and (b) creating any other broadcast at all. Prompt 0138 narrows this
// from a global rule to PER BOT — each bot may independently have its own
// active recurring broadcast, since they're otherwise fully independent
// pipelines. Only ever 0 or 1 row per bot_id.
const findActiveRecurringStmt = lazyStatement("SELECT * FROM telegram_broadcasts WHERE status = 'recurring' AND bot_id = ? LIMIT 1");
// Only ever called after a SUCCESSFUL round (see telegram/worker.js's
// sendRecurringRound) — sent_count here means "number of successful
// rounds" for a recurring broadcast, not "recipients reached" (its normal
// meaning for every other status). recurring_last_sent_at is set to the
// real current time, not "when it was due" — this is exactly what makes a
// post-restart catch-up send exactly one send, not a burst: the very next
// due-check measures the interval from this fresh timestamp, not from
// whenever the missed round was originally scheduled.
//
// Prompt 0164 — recurring_starts_at is backfilled via COALESCE(existing,
// this same send time) in the SAME statement: a broadcast whose admin chose
// "Mulai pada jam tertentu" already has an explicit recurring_starts_at
// from creation, so COALESCE is a no-op for it (the DECLARED anchor is
// preserved, never overwritten by an actual-send-time drift); a "Mulai
// sekarang" broadcast (or a genuine pre-0164 legacy row) has NULL here
// until its first-ever successful round lands, at which point THIS call
// backfills it with that real send time — giving it a genuine, drift-free
// anchor for every round from the second one onward, without the admin
// ever having to pick one. See recurringSchedule.js's own
// computeRecurringDue() for how that anchor is used.
// Prompt 0166 — also persists this round's own delivered/failed counts
// (recurring_last_round_sent_count/_failed_count) onto the same row, same
// call. Deliberately NOT accumulated into the pre-existing failed_count
// column: that column's real, established meaning elsewhere in this file
// (markChannelSendResult/incrementFailedCount) is "cumulative per-job
// failures in the subscriber-queue send path" — a recurring broadcast
// bypasses that queue entirely and has never written failed_count at all
// (confirmed against the incident row itself: failed_count stayed 0 for
// its entire life). These two new columns are the recurring path's own
// correctly-scoped equivalent, holding only the MOST RECENT round's own
// numbers, not a lifetime total across however many rounds a broadcast
// has run.
const recordRecurringSendStmt = lazyStatement(
  'UPDATE telegram_broadcasts SET sent_count = sent_count + 1, recurring_last_sent_at = ?, recurring_starts_at = COALESCE(recurring_starts_at, ?), recurring_last_round_sent_count = ?, recurring_last_round_failed_count = ?, updated_at = ? WHERE id = ?'
);
// Same atomic "only if still in the expected status" shape as
// transitionFromScheduledStmt below — the race guard the deactivate
// endpoint relies on (a concurrent worker tick and a concurrent deactivate
// request can never both "win").
const transitionFromRecurringStmt = lazyStatement(
  "UPDATE telegram_broadcasts SET status = ?, updated_at = ? WHERE id = ? AND status = 'recurring'"
);
const markChannelResultStmt = lazyStatement(`
  UPDATE telegram_broadcasts
  SET status = @status, error_message = @errorMessage, sent_count = @sentCount, failed_count = @failedCount, updated_at = @now
  WHERE id = @id
`);
const incrementSentStmt = lazyStatement('UPDATE telegram_broadcasts SET sent_count = sent_count + 1, updated_at = ? WHERE id = ?');
const incrementFailedStmt = lazyStatement('UPDATE telegram_broadcasts SET failed_count = failed_count + 1, updated_at = ? WHERE id = ?');
const findDueScheduledStmt = lazyStatement(
  "SELECT * FROM telegram_broadcasts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at ASC"
);
// The one mechanism both the cancel endpoint and the worker's schedule
// activation step rely on: an atomic "only if still scheduled" transition.
// Whichever caller reaches a given broadcast first legitimately wins; the
// other's UPDATE matches zero rows and `changes` reports that back so the
// caller can treat it as a no-op / conflict instead of silently overwriting.
const transitionFromScheduledStmt = lazyStatement(
  "UPDATE telegram_broadcasts SET status = ?, updated_at = ? WHERE id = ? AND status = 'scheduled'"
);
const setTotalCountStmt = lazyStatement('UPDATE telegram_broadcasts SET total_count = ?, updated_at = ? WHERE id = ?');
// Same "atomic, only if still scheduled" shape as transitionFromScheduledStmt
// above, just updating different columns instead of flipping status — the
// race guard for edit-content/reschedule (see telegramBroadcastController.js).
// Widened in prompt 0134 to ALSO allow 'recurring' — a deliberate exception
// per that prompt's own design: editing a still-active recurring
// broadcast's content is allowed (the next hourly round picks up the new
// content), the same as it already was for 'scheduled'. Rescheduling
// (updateScheduledAtIfScheduledStmt below) is NOT widened the same way —
// "when" has no meaning for a recurring broadcast, only "what".
const updateContentIfScheduledStmt = lazyStatement(`
  UPDATE telegram_broadcasts
  SET title = @title, title_format = @titleFormat, body = @body, media_url = @mediaUrl, media_file_id = @mediaFileId, media_server_filename = @mediaServerFilename, media_type = @mediaType, buttons = @buttons, body_format = @bodyFormat, updated_at = @now
  WHERE id = @id AND status IN ('scheduled', 'recurring')
`);
const updateScheduledAtIfScheduledStmt = lazyStatement(`
  UPDATE telegram_broadcasts SET scheduled_at = @scheduledAt, updated_at = @now
  WHERE id = @id AND status = 'scheduled'
`);
// Prompt 0141 — persists a lazily-resolved per-bot file_id back onto the
// broadcast row itself, once ensureBroadcastMediaFileId() (broadcastMedia.js)
// has produced one at actual send time (queue/scheduled/recurring paths —
// the immediate-channel/upload-time paths resolve it synchronously before
// the row is even created/updated). Deliberately unconditional (no status
// guard, unlike updateContentIfScheduledStmt above) — this never changes
// what the row means, only fills in a cache value a later read would have
// recomputed identically anyway, so there's no race to guard against.
const updateMediaFileIdStmt = lazyStatement(
  'UPDATE telegram_broadcasts SET media_file_id = ?, updated_at = ? WHERE id = ?'
);

export function createBroadcast({
  botId,
  title,
  titleFormat = 'plain',
  body,
  mediaUrl,
  mediaFileId,
  mediaServerFilename,
  mediaType,
  targetType,
  targetChannelId,
  totalCount,
  createdBy,
  scheduledAt = null,
  buttons = [],
  bodyFormat = 'plain',
  recurring = false,
  // Prompt 0164 — only meaningful when recurring is true; harmless defaults
  // (1 hour, no explicit anchor) for every non-recurring row, matching the
  // column's own DEFAULT 1 / NULL.
  recurringIntervalHours = 1,
  recurringStartsAt = null
}) {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt().run({
    id,
    botId,
    title,
    titleFormat,
    body,
    mediaUrl: mediaUrl ?? null,
    mediaFileId: mediaFileId ?? null,
    mediaServerFilename: mediaServerFilename ?? null,
    mediaType: mediaType ?? null,
    targetType,
    targetChannelId: targetChannelId ?? null,
    // Mutually exclusive by construction — the controller's own zod schema
    // already rejects a request that sets both scheduledAt and recurring,
    // so this ternary chain never has to arbitrate a genuine conflict.
    status: recurring ? 'recurring' : scheduledAt ? 'scheduled' : 'queued',
    scheduledAt: scheduledAt ?? null,
    totalCount,
    buttons: JSON.stringify(buttons ?? []),
    bodyFormat,
    isRecurring: recurring ? 1 : 0,
    recurringIntervalHours: recurringIntervalHours ?? 1,
    // Prompt 0234 (P2) — "Mulai sekarang" (no explicit anchor) now anchors
    // to the ACTIVATION time, right here at insert, instead of being
    // backfilled later with the first round's own FINISH time (which pinned
    // the whole cadence to however long that first round happened to take —
    // 2 to 3 hours for 15k subscribers in production). recordRecurringSend's
    // COALESCE backfill stays as legacy defense only; for every row created
    // from now on it is a no-op.
    recurringStartsAt: recurring ? (recurringStartsAt ?? now) : null,
    createdBy,
    now
  });
  return findByIdStmt().get(id);
}

/** At most one row for this bot, or null — see findActiveRecurringStmt's own comment. */
export function findActiveRecurringBroadcast(botId) {
  return findActiveRecurringStmt().get(botId) ?? null;
}

export function recordRecurringSend(id, sentAtIso, lastRoundSentCount, lastRoundFailedCount) {
  recordRecurringSendStmt().run(sentAtIso, sentAtIso, lastRoundSentCount, lastRoundFailedCount, new Date().toISOString(), id);
}

/**
 * Atomically moves a broadcast out of 'recurring' into `newStatus` (always
 * 'completed' from the one real caller, the deactivate endpoint), but only
 * if it is still 'recurring' at the moment this runs — same "whichever
 * caller reaches it first legitimately wins" contract as
 * transitionFromScheduled, guarding against a worker tick and a deactivate
 * request landing at the same instant.
 */
export function transitionFromRecurring(id, newStatus) {
  const result = transitionFromRecurringStmt().run(newStatus, new Date().toISOString(), id);
  return result.changes > 0;
}

/**
 * Prompt 0234 (P1) — the "Replace the active recurring broadcast" path:
 * deactivates the currently active recurring broadcast and creates its
 * replacement in ONE transaction, so there is never a window where zero or
 * two rows are 'recurring' for this bot. The old broadcast's possibly
 * in-flight round stops on its own within the worker's status-recheck
 * bound (see sendRecurringRound) the moment this commits.
 *
 * The transition uses the same atomic "only if still recurring" statement
 * the deactivate endpoint uses; if the old row was concurrently
 * deactivated already, that's fine — the end state (old inactive, new
 * active) is identical, so the create still proceeds.
 */
export function replaceActiveRecurringAndCreate(oldId, createArgs) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    transitionFromRecurring(oldId, 'completed');
    const created = createBroadcast(createArgs);
    db.exec('COMMIT');
    return created;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function findBroadcastById(id) {
  return findByIdStmt().get(id) ?? null;
}

export function listBroadcasts({ botId, status, limit = 20, offset = 0 } = {}) {
  const clauses = ['bot_id = @botId'];
  const params = { botId, limit, offset };
  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  return getDb()
    .prepare(`SELECT * FROM telegram_broadcasts ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`)
    .all(params);
}

/** Generic status transition — used by the worker for queued -> sending -> completed/partial. */
export function setStatus(id, status) {
  setStatusStmt().run(status, new Date().toISOString(), id);
  return findByIdStmt().get(id);
}

/** The synchronous channel-target path: one message, one terminal outcome. */
export function markChannelSendResult(id, { success, errorMessage }) {
  markChannelResultStmt().run({
    id,
    status: success ? 'completed' : 'failed',
    errorMessage: success ? null : errorMessage,
    sentCount: success ? 1 : 0,
    failedCount: success ? 0 : 1,
    now: new Date().toISOString()
  });
  return findByIdStmt().get(id);
}

export function incrementSentCount(id) {
  incrementSentStmt().run(new Date().toISOString(), id);
}

export function incrementFailedCount(id) {
  incrementFailedStmt().run(new Date().toISOString(), id);
}

/** Broadcasts whose scheduled_at has arrived (or passed — catch-up-safe by
 * construction: a plain <= comparison against "now" still matches a
 * schedule that was due while the server was down). */
export function findDueScheduledBroadcasts(nowIso) {
  return findDueScheduledStmt().all(nowIso);
}

/**
 * Atomically moves a broadcast out of 'scheduled' into `newStatus`, but
 * only if it is still 'scheduled' at the moment this runs. Returns true if
 * this call actually changed the row (i.e. this caller "won" the race),
 * false if something else (the worker's own activation, or a concurrent
 * cancel) already moved it first.
 */
export function transitionFromScheduled(id, newStatus) {
  const result = transitionFromScheduledStmt().run(newStatus, new Date().toISOString(), id);
  return result.changes > 0;
}

export function setTotalCount(id, totalCount) {
  setTotalCountStmt().run(totalCount, new Date().toISOString(), id);
}

/**
 * Edits a still-`scheduled` OR still-`recurring` broadcast's message
 * content (title/body/media/buttons only — never target/schedule). Returns
 * false, changing nothing, if the row is in neither status at the moment
 * this runs (e.g. the worker just claimed a scheduled one, or a recurring
 * one was just deactivated) — same "lost the race" contract as
 * transitionFromScheduled/transitionFromRecurring.
 */
export function updateScheduledContent(id, { title, titleFormat = 'plain', body, mediaUrl, mediaFileId, mediaServerFilename, mediaType, buttons, bodyFormat = 'plain' }) {
  const result = updateContentIfScheduledStmt().run({
    id,
    title,
    titleFormat,
    body,
    mediaUrl: mediaUrl ?? null,
    mediaFileId: mediaFileId ?? null,
    mediaServerFilename: mediaServerFilename ?? null,
    mediaType: mediaType ?? null,
    buttons: JSON.stringify(buttons ?? []),
    bodyFormat,
    now: new Date().toISOString()
  });
  return result.changes > 0;
}

/** Same race-safe contract as updateScheduledContent, but only scheduled_at. */
export function updateScheduledTime(id, scheduledAt) {
  const result = updateScheduledAtIfScheduledStmt().run({ id, scheduledAt, now: new Date().toISOString() });
  return result.changes > 0;
}

/** Persists a lazily-resolved file_id onto this row — see updateMediaFileIdStmt's own comment for why this is unconditional. */
export function updateMediaFileId(id, mediaFileId) {
  updateMediaFileIdStmt().run(mediaFileId, new Date().toISOString(), id);
}
