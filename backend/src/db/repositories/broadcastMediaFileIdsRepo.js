/**
 * Data access for `telegram_broadcast_media_file_ids` (prompt 0141) — the
 * per-(server file, bot) cache of "this bot has already uploaded this
 * exact file's bytes to its own storage chat and gotten this file_id back".
 * See `backend/src/telegram/broadcastMedia.js`'s `ensureBroadcastMediaFileId()`
 * for the only caller that actually reads AND writes this table — this
 * module is pure data access, no Telegram I/O.
 */
import { lazyStatement } from '../client.js';

const findStmt = lazyStatement(
  'SELECT file_id FROM telegram_broadcast_media_file_ids WHERE media_filename = ? AND bot_id = ?'
);

// ON CONFLICT DO NOTHING rather than DO UPDATE: once a bot has a file_id
// for a given server file, that mapping never legitimately changes (the
// file's own bytes never change after upload — see broadcastMedia.js's own
// saveServerMedia(), which always writes a brand-new UUID filename rather
// than overwriting one) — a second insert attempt for the same pair can
// only happen if two concurrent sends raced to resolve the same not-yet-
// cached (file, bot) pair, in which case the first writer's row should win
// untouched, not be silently replaced by a second, functionally-identical
// file_id.
const insertStmt = lazyStatement(`
  INSERT INTO telegram_broadcast_media_file_ids (media_filename, bot_id, file_id, created_at)
  VALUES (@mediaFilename, @botId, @fileId, @now)
  ON CONFLICT(media_filename, bot_id) DO NOTHING
`);

/** Returns the cached file_id for this exact (server file, bot) pair, or null if this bot has never uploaded it before. */
export function findBroadcastMediaFileId(mediaFilename, botId) {
  const row = findStmt().get(mediaFilename, botId);
  return row ? row.file_id : null;
}

export function saveBroadcastMediaFileId(mediaFilename, botId, fileId) {
  insertStmt().run({ mediaFilename, botId, fileId, now: new Date().toISOString() });
}
