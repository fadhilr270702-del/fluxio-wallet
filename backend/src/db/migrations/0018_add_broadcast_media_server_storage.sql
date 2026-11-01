-- Server-side broadcast media storage (prompt 0141, Stage C of the dual-bot
-- arc). Every broadcast media upload used to go straight to Telegram (via
-- the bot hardcoded to 'test') and get discarded server-side the instant
-- the request ended — a file_id is scoped to the bot that issued it (see
-- prompt 0135's own investigation), so that file_id was never reusable by
-- the 'official' bot at all. This migration adds a place to keep the
-- actual bytes (bot-agnostic — the same media, shared across bots) and a
-- place to cache which bots have already turned those bytes into their own
-- file_id, so a given upload only ever gets pushed to a given bot's
-- storage chat once, no matter how many times it's reused via "Salin ke
-- form" across bots.
--
-- Plain ADD COLUMN + CREATE TABLE — no manual-transaction marker needed
-- (see migrations 0011/0012/0016's own precedent for this exact shape;
-- 0008/0013/0017 needed the marker only because THEY rebuilt an existing
-- table under a CHECK constraint change, which this migration doesn't do).
--
-- Backfill: media_server_filename is left NULL for every existing row —
-- every broadcast created before this prompt was uploaded through the old
-- discard-after-Telegram-upload path, so there is no server file to point
-- at for any of them; their own already-stored media_file_id values need
-- no change at all, since every one of them was already issued by 'test'
-- (the only bot broadcast media upload was ever hardcoded to before this
-- prompt) and every existing row's own bot_id was already backfilled to
-- 'test' in migration 0017 — the two already agree, nothing to reconcile.
-- The new telegram_broadcast_media_file_ids cache table starts empty for
-- the same reason: it's keyed by media_filename, and no legacy row has one.

ALTER TABLE telegram_broadcasts ADD COLUMN media_server_filename TEXT;

-- One row per (server file, bot) that has ever actually uploaded that
-- file's bytes to its own storage chat and gotten a file_id back — a
-- broadcast row's own media_file_id is a plain cache of "this row's own
-- bot's file_id", but this table is what makes that cache reusable across
-- MULTIPLE broadcast rows that reference the same underlying file (the
-- normal outcome of "Salin ke form" carrying a server file forward without
-- re-uploading raw bytes into a fresh Compose session).
CREATE TABLE telegram_broadcast_media_file_ids (
  media_filename TEXT NOT NULL,
  bot_id TEXT NOT NULL CHECK (bot_id IN ('test', 'official')),
  file_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (media_filename, bot_id)
);
