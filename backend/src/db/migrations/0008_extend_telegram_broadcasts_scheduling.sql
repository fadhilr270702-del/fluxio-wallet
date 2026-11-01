-- fluxio:manual-transaction
-- Widens telegram_broadcasts.status to add 'scheduled'/'canceled', and adds
-- a nullable scheduled_at column, for Slice 6 (schedule a broadcast for a
-- future one-time send, cancel it beforehand).
--
-- SQLite can't ALTER a CHECK constraint in place, so the table has to be
-- recreated (create-new / copy / drop-old / rename), which in turn requires
-- disabling foreign-key enforcement while telegram_broadcast_recipients'
-- FK to this table is briefly pointed at a dropped table. `PRAGMA
-- foreign_keys` is a documented no-op while a transaction is already open —
-- migrate.js's default wrapping opens one — so this file carries the
-- `-- fluxio:manual-transaction` marker above, which tells the runner to
-- exec this file as-is (autocommit-by-default, own BEGIN/COMMIT below)
-- instead of wrapping it. See migrate.js and CLAUDE.md for the full
-- reasoning; this exact sequence was verified end-to-end against a
-- throwaway node:sqlite database before being adopted here.

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
    CHECK (status IN ('queued', 'scheduled', 'sending', 'completed', 'partial', 'failed', 'canceled')),
  scheduled_at TEXT,
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO telegram_broadcasts_new (
  id, title, body, media_url, target_type, target_channel_id, status, scheduled_at,
  total_count, sent_count, failed_count, error_message, created_by, created_at, updated_at
)
SELECT
  id, title, body, media_url, target_type, target_channel_id, status, NULL,
  total_count, sent_count, failed_count, error_message, created_by, created_at, updated_at
FROM telegram_broadcasts;

DROP TABLE telegram_broadcasts;
ALTER TABLE telegram_broadcasts_new RENAME TO telegram_broadcasts;

CREATE INDEX idx_telegram_broadcasts_status_created ON telegram_broadcasts(status, created_at);
CREATE INDEX idx_telegram_broadcasts_status_scheduled ON telegram_broadcasts(status, scheduled_at);

COMMIT;

PRAGMA foreign_keys = ON;
