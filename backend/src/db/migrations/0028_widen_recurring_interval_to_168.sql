-- fluxio:manual-transaction
-- Prompt 0246 — widens telegram_broadcasts.recurring_interval_hours from
-- CHECK (BETWEEN 1 AND 24) to CHECK (BETWEEN 1 AND 168), so a recurring
-- broadcast can run on a daily-plus cadence up to weekly (the schedule can
-- now be edited from the admin's Edit page, and the owner asked for up to
-- 168 hours).
--
-- Same reasoning as migrations 0008 and 0013: SQLite cannot ALTER a CHECK
-- constraint in place, so the table is recreated (create-new / copy /
-- drop-old / rename). That needs foreign-key enforcement OFF while the
-- drop happens, for TWO child tables this time:
--   * telegram_broadcast_recipients.broadcast_id — ON DELETE CASCADE. With
--     enforcement ON, DROP TABLE performs an implicit DELETE and would
--     cascade away every recipient row. Enforcement OFF is what keeps them.
--   * telegram_recurring_rounds.broadcast_id — NO ACTION (migration 0027).
-- PRAGMA foreign_keys is a documented no-op inside a transaction, which is
-- why this file carries the manual-transaction marker (migrate.js then runs
-- it as one autocommit exec instead of wrapping it in BEGIN/COMMIT).
--
-- The CREATE TABLE below mirrors the table's CURRENT full live shape,
-- taken from a database freshly migrated 0001..0027 (sqlite_master +
-- pragma table_info, not assumed from migration history): the 21 columns
-- of 0013's own rebuild, then the seven added since by plain ALTER TABLE —
-- bot_id, media_server_filename, title_format, recurring_interval_hours,
-- recurring_starts_at, recurring_last_round_sent_count,
-- recurring_last_round_failed_count — in that same order. The ONLY
-- difference from the old table is the upper bound of the interval CHECK.
-- All three indexes are recreated (the two from 0013 plus
-- idx_telegram_broadcasts_bot_status).
--
-- Locked by backend/src/db/test/migration0028.test.js, which migrates a
-- database to 0027, fills it with an active recurring broadcast, its
-- rounds and a queued broadcast's recipients, applies this file, and
-- proves every row identical, the foreign keys intact and still enforced.

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE telegram_broadcasts_new (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  media_url TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('channel', 'subscribers')),
  target_channel_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'scheduled', 'recurring', 'sending', 'completed', 'partial', 'failed', 'canceled')),
  scheduled_at TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  buttons TEXT NOT NULL DEFAULT '[]',
  body_format TEXT NOT NULL DEFAULT 'plain' CHECK (body_format IN ('plain', 'html')),
  media_file_id TEXT,
  media_type TEXT CHECK (media_type IN ('image', 'video')),
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_last_sent_at TEXT,
  bot_id TEXT NOT NULL DEFAULT 'test' CHECK (bot_id IN ('test', 'official')),
  media_server_filename TEXT,
  title_format TEXT NOT NULL DEFAULT 'plain' CHECK (title_format IN ('plain', 'html')),
  recurring_interval_hours INTEGER NOT NULL DEFAULT 1 CHECK (recurring_interval_hours BETWEEN 1 AND 168),
  recurring_starts_at TEXT,
  recurring_last_round_sent_count INTEGER,
  recurring_last_round_failed_count INTEGER
);

INSERT INTO telegram_broadcasts_new (
  id, title, body, media_url, target_type, target_channel_id, status, scheduled_at,
  total_count, sent_count, failed_count, error_message, created_by, created_at, updated_at,
  buttons, body_format, media_file_id, media_type, is_recurring, recurring_last_sent_at,
  bot_id, media_server_filename, title_format, recurring_interval_hours, recurring_starts_at,
  recurring_last_round_sent_count, recurring_last_round_failed_count
)
SELECT
  id, title, body, media_url, target_type, target_channel_id, status, scheduled_at,
  total_count, sent_count, failed_count, error_message, created_by, created_at, updated_at,
  buttons, body_format, media_file_id, media_type, is_recurring, recurring_last_sent_at,
  bot_id, media_server_filename, title_format, recurring_interval_hours, recurring_starts_at,
  recurring_last_round_sent_count, recurring_last_round_failed_count
FROM telegram_broadcasts;

DROP TABLE telegram_broadcasts;
ALTER TABLE telegram_broadcasts_new RENAME TO telegram_broadcasts;

CREATE INDEX idx_telegram_broadcasts_status_created ON telegram_broadcasts(status, created_at);
CREATE INDEX idx_telegram_broadcasts_status_scheduled ON telegram_broadcasts(status, scheduled_at);
CREATE INDEX idx_telegram_broadcasts_bot_status ON telegram_broadcasts(bot_id, status);

COMMIT;

PRAGMA foreign_keys = ON;
