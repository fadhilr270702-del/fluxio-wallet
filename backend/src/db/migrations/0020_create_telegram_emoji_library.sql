-- Prompt 0152 — the premium custom-emoji library, per bot. A registered
-- pack's own `file_id`/custom_emoji info is bot-scoped (the permanent
-- lesson from prompt 0135: a file_id is only ever meaningful against the
-- bot that issued it), so every row in both tables below carries bot_id
-- rather than assuming one shared library — a pack registered on 'test'
-- and the "same" pack registered on 'official' are two independent rows
-- with two independent sets of file_ids, even though they came from the
-- same Telegram sticker set name.
--
-- One registered pack per (bot_id, set_name) — re-registering the same
-- name for the same bot is a refresh, not a duplicate (see the register
-- endpoint's own upsert logic).
CREATE TABLE telegram_emoji_packs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL CHECK (bot_id IN ('test', 'official')),
  set_name TEXT NOT NULL,
  title TEXT NOT NULL,
  sticker_type TEXT NOT NULL,
  emoji_count INTEGER NOT NULL DEFAULT 0,
  registered_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bot_id, set_name)
);
CREATE INDEX idx_telegram_emoji_packs_bot ON telegram_emoji_packs(bot_id);

-- Keyed on (bot_id, custom_emoji_id) directly rather than a synthetic id —
-- that pair is already the natural unique identity Telegram itself uses,
-- and every real lookup this library ever needs (the asset proxy, a future
-- 0153 picker) is "give me bot X's emoji Y", never "give me row N".
-- `position` preserves the pack's own emoji ordering (as Telegram returned
-- it) for a stable grid layout; refreshed by a full delete-and-reinsert on
-- every register/refresh (see the repo's own upsertPackWithEmojis()),
-- which is also what makes a refresh's add/remove sync trivially correct —
-- whatever set of rows exists after a refresh IS the current truth, no
-- separate diffing logic needed. ON DELETE CASCADE removes a pack's own
-- emoji rows automatically when the pack itself is removed.
CREATE TABLE telegram_custom_emojis (
  bot_id TEXT NOT NULL CHECK (bot_id IN ('test', 'official')),
  custom_emoji_id TEXT NOT NULL,
  pack_id TEXT NOT NULL REFERENCES telegram_emoji_packs(id) ON DELETE CASCADE,
  fallback_emoji TEXT NOT NULL,
  is_animated INTEGER NOT NULL DEFAULT 0,
  is_video INTEGER NOT NULL DEFAULT 0,
  file_id TEXT NOT NULL,
  file_unique_id TEXT NOT NULL,
  file_size INTEGER,
  thumb_file_id TEXT,
  thumb_file_unique_id TEXT,
  thumb_width INTEGER,
  thumb_height INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bot_id, custom_emoji_id)
);
CREATE INDEX idx_telegram_custom_emojis_pack ON telegram_custom_emojis(pack_id);
