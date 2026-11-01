/**
 * Data access for the premium-emoji library (prompt 0152) —
 * `telegram_emoji_packs` + `telegram_custom_emojis`, both bot-scoped (see
 * the migration's own header for why). `upsertPackWithEmojis()` is the one
 * function both register AND refresh call — a register is really just a
 * refresh of a pack this bot has never seen before, so there's no separate
 * "insert" vs. "sync" code path to keep in agreement with each other.
 */
import { randomUUID } from 'node:crypto';
import { getDb, lazyStatement } from '../client.js';

const findPackByBotAndNameStmt = lazyStatement(
  'SELECT * FROM telegram_emoji_packs WHERE bot_id = ? AND set_name = ?'
);
const findPackByIdStmt = lazyStatement('SELECT * FROM telegram_emoji_packs WHERE id = ? AND bot_id = ?');
const insertPackStmt = lazyStatement(`
  INSERT INTO telegram_emoji_packs (id, bot_id, set_name, title, sticker_type, emoji_count, registered_by, created_at, updated_at)
  VALUES (@id, @botId, @setName, @title, @stickerType, @emojiCount, @registeredBy, @now, @now)
`);
const updatePackStmt = lazyStatement(`
  UPDATE telegram_emoji_packs
  SET title = @title, sticker_type = @stickerType, emoji_count = @emojiCount, updated_at = @now
  WHERE id = @id
`);
const deletePackStmt = lazyStatement('DELETE FROM telegram_emoji_packs WHERE id = ?');

// LEFT JOIN + live COUNT/SUM rather than trusting the packs table's own
// cached emoji_count column for animated/video breakdowns — that column
// only tracks the total (kept in sync by upsertPackWithEmojis below), and
// there's no equivalent stored column for animated/video counts per the
// migration's own given schema, so those are always computed fresh from
// the actual emoji rows instead of a second column that could drift.
const listPacksForBotStmt = lazyStatement(`
  SELECT
    p.*,
    COUNT(e.custom_emoji_id) AS live_emoji_count,
    COALESCE(SUM(e.is_animated), 0) AS animated_count,
    COALESCE(SUM(e.is_video), 0) AS video_count
  FROM telegram_emoji_packs p
  LEFT JOIN telegram_custom_emojis e ON e.pack_id = p.id
  WHERE p.bot_id = ?
  GROUP BY p.id
  ORDER BY p.created_at ASC
`);

const deleteEmojisForPackStmt = lazyStatement('DELETE FROM telegram_custom_emojis WHERE pack_id = ?');
const insertEmojiStmt = lazyStatement(`
  INSERT INTO telegram_custom_emojis
    (bot_id, custom_emoji_id, pack_id, fallback_emoji, is_animated, is_video, file_id, file_unique_id, file_size, thumb_file_id, thumb_file_unique_id, thumb_width, thumb_height, position)
  VALUES
    (@botId, @customEmojiId, @packId, @fallbackEmoji, @isAnimated, @isVideo, @fileId, @fileUniqueId, @fileSize, @thumbFileId, @thumbFileUniqueId, @thumbWidth, @thumbHeight, @position)
`);
const listEmojisForPackStmt = lazyStatement('SELECT * FROM telegram_custom_emojis WHERE pack_id = ? ORDER BY position ASC');
const findEmojiByBotAndIdStmt = lazyStatement(
  'SELECT * FROM telegram_custom_emojis WHERE bot_id = ? AND custom_emoji_id = ?'
);

export function findPackByBotAndName(botId, setName) {
  return findPackByBotAndNameStmt().get(botId, setName) ?? null;
}

export function findPackById(id, botId) {
  return findPackByIdStmt().get(id, botId) ?? null;
}

export function listPacksForBot(botId) {
  return listPacksForBotStmt().all(botId);
}

export function listEmojisForPack(packId) {
  return listEmojisForPackStmt().all(packId);
}

export function findEmojiByBotAndId(botId, customEmojiId) {
  return findEmojiByBotAndIdStmt().get(botId, customEmojiId) ?? null;
}

/**
 * Upserts one pack row and fully replaces its emoji rows in one
 * transaction (hand-rolled BEGIN/COMMIT/ROLLBACK — node:sqlite's
 * DatabaseSync has no db.transaction() helper, same pattern as
 * telegramRecipientsRepo.js's bulkInsertPending). `registeredBy` is only
 * ever applied on the FIRST insert — a refresh never changes who
 * originally registered a pack, only what its metadata/emoji currently
 * are, so it's simply ignored on the update branch.
 *
 * A delete-then-reinsert of every emoji row (rather than a diff against
 * the previous set) is deliberate, not lazy: whatever Telegram returns for
 * this getStickerSet call becomes the pack's full, authoritative emoji
 * list afterward, which is exactly "sinkron tambah dan hapus emoji" with
 * no separate add/remove logic that could itself drift from a plain
 * re-fetch.
 *
 * `emojis` — plain objects: {customEmojiId, fallbackEmoji, isAnimated,
 * isVideo, fileId, fileUniqueId, fileSize, thumbFileId, thumbFileUniqueId,
 * thumbWidth, thumbHeight}, already in the order they should be stored at.
 */
export function upsertPackWithEmojis({ botId, setName, title, stickerType, emojis, registeredBy }) {
  const now = new Date().toISOString();
  const existing = findPackByBotAndNameStmt().get(botId, setName);

  let packId;
  const db = getDb();
  db.exec('BEGIN');
  try {
    if (existing) {
      packId = existing.id;
      updatePackStmt().run({ id: packId, title, stickerType, emojiCount: emojis.length, now });
    } else {
      packId = randomUUID();
      insertPackStmt().run({
        id: packId,
        botId,
        setName,
        title,
        stickerType,
        emojiCount: emojis.length,
        registeredBy,
        now
      });
    }

    deleteEmojisForPackStmt().run(packId);
    emojis.forEach((emoji, index) => {
      insertEmojiStmt().run({
        botId,
        customEmojiId: emoji.customEmojiId,
        packId,
        fallbackEmoji: emoji.fallbackEmoji,
        isAnimated: emoji.isAnimated ? 1 : 0,
        isVideo: emoji.isVideo ? 1 : 0,
        fileId: emoji.fileId,
        fileUniqueId: emoji.fileUniqueId,
        fileSize: emoji.fileSize ?? null,
        thumbFileId: emoji.thumbFileId ?? null,
        thumbFileUniqueId: emoji.thumbFileUniqueId ?? null,
        thumbWidth: emoji.thumbWidth ?? null,
        thumbHeight: emoji.thumbHeight ?? null,
        position: index
      });
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return findPackByIdStmt().get(packId, botId);
}

/** Cascades to the pack's own emoji rows via ON DELETE CASCADE (see the migration). */
export function deletePack(id) {
  deletePackStmt().run(id);
}
