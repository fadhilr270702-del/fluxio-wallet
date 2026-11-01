/**
 * Data access for `welcome_versions` (prompt 0137) — a permanent, append-
 * only content-version history for the admin-editable welcome message.
 * Every row is a full snapshot of what was saved at that moment; nothing
 * here is ever updated in place, only inserted and (once pruned beyond the
 * retention limit) deleted.
 *
 * Prompt 0138 (dual-bot foundation) — every row now carries its own bot_id,
 * and every list/prune/orphan-scan query below is scoped by it, so bot A's
 * 20-version retention window can never see, count, or delete bot B's
 * versions or files. findWelcomeVersionById stays global-by-id (a UUID,
 * already unique across bots) — it's only ever reached via an admin-only
 * "view this specific version's media" request for an id the admin UI
 * itself already resolved from a bot-scoped list, so there's no cross-bot
 * ambiguity to close here.
 */
import { randomUUID } from 'node:crypto';
import { lazyStatement } from '../client.js';

const insertStmt = lazyStatement(`
  INSERT INTO welcome_versions (id, bot_id, body, body_format, image_filename, media_type, buttons, updated_by, created_at)
  VALUES (@id, @botId, @body, @bodyFormat, @imageFilename, @mediaType, @buttons, @updatedBy, @now)
`);

// LEFT JOIN (not INNER) so a version an admin account was later deactivated
// for still shows up in history — admins.is_active only gates login, never
// hides past actions (same reasoning as the audit log's own admin join).
const listStmt = lazyStatement(`
  SELECT wv.*, a.email AS updated_by_email
  FROM welcome_versions wv
  LEFT JOIN admins a ON a.id = wv.updated_by
  WHERE wv.bot_id = ?
  ORDER BY wv.created_at DESC
`);

const findByIdStmt = lazyStatement('SELECT * FROM welcome_versions WHERE id = ?');
const countStmt = lazyStatement('SELECT COUNT(*) AS count FROM welcome_versions WHERE bot_id = ?');

// SQLite's `LIMIT -1 OFFSET n` means "everything after skipping the first n
// rows" — ordered newest-first (within this bot's own versions only), this
// is exactly "every version older than the most recent n FOR THIS BOT", the
// exact set pruning needs to consider for deletion.
const findBeyondStmt = lazyStatement(
  'SELECT id, image_filename FROM welcome_versions WHERE bot_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?'
);
const deleteByIdStmt = lazyStatement('DELETE FROM welcome_versions WHERE id = ?');
const listAllImageFilenamesStmt = lazyStatement(
  'SELECT image_filename FROM welcome_versions WHERE bot_id = ? AND image_filename IS NOT NULL'
);

export function insertWelcomeVersion({ botId, body, bodyFormat, imageFilename, mediaType, buttons, updatedBy }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  insertStmt().run({
    id,
    botId,
    body,
    bodyFormat,
    imageFilename: imageFilename ?? null,
    mediaType: mediaType ?? null,
    buttons: JSON.stringify(buttons || []),
    updatedBy,
    now
  });
  return id;
}

export function listWelcomeVersions(botId) {
  return listStmt().all(botId);
}

export function findWelcomeVersionById(id) {
  return findByIdStmt().get(id) ?? null;
}

export function countWelcomeVersions(botId) {
  return countStmt().get(botId).count;
}

/**
 * Deletes every version beyond the most recent `limit` (by created_at)
 * WITHIN THIS BOT'S OWN versions, returning each deleted row's own
 * `{id, image_filename}` — the caller (welcomeController.js's own pruning
 * step) uses these to decide which files, if any, are now safe to remove
 * from disk. Deletes the DB rows first and returns before any file-reference
 * check happens, which is deliberate: the caller must compute "what's still
 * referenced" by querying the table's state AFTER this deletion, never
 * before, or a version about to be deleted would incorrectly still count as
 * a reference to its own file.
 */
export function pruneVersionsBeyond(botId, limit) {
  const toDelete = findBeyondStmt().all(botId, limit);
  for (const row of toDelete) {
    deleteByIdStmt().run(row.id);
  }
  return toDelete;
}

/** Every image_filename still referenced by ANY remaining version OF THIS BOT — call after pruneVersionsBeyond(botId, ...), not before. */
export function listAllVersionImageFilenames(botId) {
  return listAllImageFilenamesStmt().all(botId).map((row) => row.image_filename);
}
