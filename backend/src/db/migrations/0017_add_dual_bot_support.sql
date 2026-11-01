-- fluxio:manual-transaction
-- Dual-bot foundation (prompt 0138, Stage A) — every table that stores
-- per-bot data (subscribers, broadcasts, welcome config + its version
-- history) gains a bot_id column identifying which bot it belongs to.
-- Every existing row belongs to the trial bot ('test') — nothing has ever
-- been tied to any other bot, so the backfill is unconditional.
--
-- Three of the five changes below (telegram_subscribers, telegram_poll_state,
-- welcome_message) require a full table rebuild, not a plain ADD COLUMN,
-- which is why this whole file needs the manual-transaction marker (see
-- migration 0008's own comment on why a rebuild needs autocommit mode for
-- its PRAGMA foreign_keys=OFF to actually take effect):
--   - telegram_subscribers' chat_id had a bare UNIQUE constraint; that has
--     to become UNIQUE(bot_id, chat_id) instead, since the SAME chat_id
--     (a user's own Telegram id) can legitimately /start both bots
--     independently — a bare column UNIQUE can't be altered in place.
--   - telegram_poll_state and welcome_message were both true singletons
--     (`id INTEGER PRIMARY KEY CHECK (id = 1)`) — each needs to become one
--     row PER bot, so the primary key itself changes to `bot_id`, which
--     also can't be altered in place.
-- The other two (telegram_broadcasts, welcome_versions) only need a plain
-- ADD COLUMN with a DEFAULT, which SQLite backfills onto every existing
-- row automatically — bundled into this same file since they're one
-- coordinated feature, even though neither individually needed the
-- manual-transaction path (see migrations 0011/0012/0016's own precedent
-- for this exact ADD-COLUMN-with-CHECK shape).
--
-- The live schema of every rebuilt table was verified directly against
-- the running dev database before writing this file (same practice
-- migrations 0008/0013 established), not assumed from an earlier
-- migration's own column list.

PRAGMA foreign_keys = OFF;
BEGIN;

-- (a) telegram_subscribers — bot_id + UNIQUE(bot_id, chat_id) replacing
-- the old bare UNIQUE(chat_id). telegram_broadcast_recipients.subscriber_id
-- references this table's `id`, which is preserved verbatim below, so that
-- FK stays valid with no changes needed on the recipients table itself.
CREATE TABLE telegram_subscribers_new (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL CHECK (bot_id IN ('test', 'official')),
  chat_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  started_at TEXT NOT NULL,
  last_interaction_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_welcomed_update_id INTEGER,
  UNIQUE (bot_id, chat_id)
);
INSERT INTO telegram_subscribers_new (
  id, bot_id, chat_id, username, first_name, is_active,
  started_at, last_interaction_at, created_at, updated_at, last_welcomed_update_id
)
SELECT
  id, 'test', chat_id, username, first_name, is_active,
  started_at, last_interaction_at, created_at, updated_at, last_welcomed_update_id
FROM telegram_subscribers;
DROP TABLE telegram_subscribers;
ALTER TABLE telegram_subscribers_new RENAME TO telegram_subscribers;
CREATE INDEX idx_telegram_subscribers_active ON telegram_subscribers(is_active);
CREATE INDEX idx_telegram_subscribers_bot ON telegram_subscribers(bot_id);

-- (b) telegram_poll_state — was a singleton (id=1); now one row per bot,
-- keyed directly on bot_id instead of a fixed literal id.
CREATE TABLE telegram_poll_state_new (
  bot_id TEXT PRIMARY KEY CHECK (bot_id IN ('test', 'official')),
  update_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO telegram_poll_state_new (bot_id, update_offset, updated_at)
SELECT 'test', update_offset, updated_at FROM telegram_poll_state WHERE id = 1;
DROP TABLE telegram_poll_state;
ALTER TABLE telegram_poll_state_new RENAME TO telegram_poll_state;

-- (c) telegram_broadcasts — plain ADD COLUMN; every existing row
-- unconditionally backfilled to 'test' via the DEFAULT clause itself (no
-- separate UPDATE needed, unlike media_type in 0012/0016, since bot_id
-- applies uniformly to every row rather than only rows that already had
-- some other value set).
ALTER TABLE telegram_broadcasts ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'test' CHECK (bot_id IN ('test', 'official'));
CREATE INDEX idx_telegram_broadcasts_bot_status ON telegram_broadcasts(bot_id, status);

-- (d) welcome_message — was a singleton (id=1); now one row per bot, same
-- shape change as telegram_poll_state above.
CREATE TABLE welcome_message_new (
  bot_id TEXT PRIMARY KEY CHECK (bot_id IN ('test', 'official')),
  body TEXT NOT NULL,
  body_format TEXT NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'html')),
  image_filename TEXT,
  buttons TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  media_type TEXT CHECK (media_type IN ('image', 'video'))
);
INSERT INTO welcome_message_new (
  bot_id, body, body_format, image_filename, buttons, updated_by, created_at, updated_at, media_type
)
SELECT
  'test', body, body_format, image_filename, buttons, updated_by, created_at, updated_at, media_type
FROM welcome_message WHERE id = 1;
DROP TABLE welcome_message;
ALTER TABLE welcome_message_new RENAME TO welcome_message;

-- (e) welcome_versions — plain ADD COLUMN, same unconditional-backfill
-- reasoning as telegram_broadcasts above. Filenames themselves also start
-- encoding bot_id as of this prompt (see welcome.js's saveUploadedMedia())
-- so a future pruning pass for bot A can never even name-collide with, let
-- alone delete, a file that belongs to bot B — this column is what lets
-- the pruning queries themselves stay scoped per bot too, not just rely on
-- the filename's own uniqueness.
ALTER TABLE welcome_versions ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'test' CHECK (bot_id IN ('test', 'official'));
CREATE INDEX idx_welcome_versions_bot_created ON welcome_versions(bot_id, created_at);

COMMIT;
PRAGMA foreign_keys = ON;
