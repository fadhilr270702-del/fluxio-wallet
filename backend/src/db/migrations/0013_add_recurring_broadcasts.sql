-- fluxio:manual-transaction
-- Adds hourly-recurring broadcasts (prompt 0134): widens telegram_broadcasts
-- .status to add 'recurring', and adds is_recurring + recurring_last_sent_at
-- columns.
--
-- Same reasoning as migration 0008: SQLite can't ALTER a CHECK constraint in
-- place, so the table has to be recreated (create-new / copy / drop-old /
-- rename), which requires disabling foreign-key enforcement while
-- telegram_broadcast_recipients' FK to this table is briefly pointed at a
-- dropped table — hence the `-- fluxio:manual-transaction` marker (PRAGMA
-- foreign_keys is a documented no-op mid-transaction, which migrate.js's
-- default wrapping always opens). This migration's CREATE TABLE mirrors the
-- table's CURRENT full live schema (verified directly against the running
-- dev DB before writing this file, not assumed from migration history alone
-- — migrations 0009-0012 each added one column via plain ALTER TABLE since
-- migration 0008's own last rebuild, so all of buttons/body_format/
-- media_file_id/media_type must be preserved here too, not just 0008's
-- original column set).
--
-- is_recurring (INTEGER 0/1, same boolean-as-integer convention as
-- admins.is_active) is a PERMANENT marker, never reset back to 0 once a
-- broadcast has ever been activated as recurring — even after deactivation
-- (status flips to 'completed'), is_recurring stays 1 so History/the detail
-- page can still show "this was an auto-broadcast, sent N times" instead of
-- looking like an ordinary one-off send. recurring_last_sent_at (nullable
-- ISO-8601, same format as every other *_at column) is null until the first
-- successful round and is what the worker's own due-check reads each tick.
-- sent_count is deliberately NOT a new column — while is_recurring is set,
-- the EXISTING sent_count column is reinterpreted as "number of successful
-- rounds" rather than "number of individual recipients reached" (its normal
-- meaning for a non-recurring broadcast); the two meanings never collide
-- since a given row is either recurring or not. failed_count/total_count
-- are left unused (0) for recurring rows — see telegram/worker.js's
-- sendRecurringRound() and prompt 0134's own archive for the full reasoning
-- on why recurring rounds deliberately bypass the telegram_broadcast_
-- recipients queue entirely instead of overloading its completion logic.

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
  recurring_last_sent_at TEXT
);

INSERT INTO telegram_broadcasts_new (
  id, title, body, media_url, target_type, target_channel_id, status, scheduled_at,
  total_count, sent_count, failed_count, error_message, created_by, created_at, updated_at,
  buttons, body_format, media_file_id, media_type, is_recurring, recurring_last_sent_at
)
SELECT
  id, title, body, media_url, target_type, target_channel_id, status, scheduled_at,
  total_count, sent_count, failed_count, error_message, created_by, created_at, updated_at,
  buttons, body_format, media_file_id, media_type, 0, NULL
FROM telegram_broadcasts;

DROP TABLE telegram_broadcasts;
ALTER TABLE telegram_broadcasts_new RENAME TO telegram_broadcasts;

CREATE INDEX idx_telegram_broadcasts_status_created ON telegram_broadcasts(status, created_at);
CREATE INDEX idx_telegram_broadcasts_status_scheduled ON telegram_broadcasts(status, scheduled_at);

COMMIT;

PRAGMA foreign_keys = ON;
