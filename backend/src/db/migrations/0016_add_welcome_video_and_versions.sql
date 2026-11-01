-- Video support + content-version history for the admin-editable welcome
-- message (prompt 0137).
--
-- media_type follows the exact same generalization pattern
-- telegram_broadcasts' own media_url -> media_file_id/media_type slice
-- used (migrations 0011/0012): image_filename keeps the name it already had
-- from prompt 0136 rather than being renamed (no rename precedent anywhere
-- in this schema's history), but from this migration on it holds either an
-- image OR a video's filename; media_type disambiguates which. Backfilled
-- to 'image' for any row that already has a filename, since video never
-- existed as an option before this migration.
ALTER TABLE welcome_message ADD COLUMN media_type TEXT CHECK (media_type IN ('image', 'video'));
UPDATE welcome_message SET media_type = 'image' WHERE media_type IS NULL AND image_filename IS NOT NULL;

-- One permanent row per Save — a content-version snapshot, independent of
-- welcome_message's own single active row (which stays the poller's real
-- send-time source of truth; this table is read-only history, never sent
-- from directly). Deliberately NOT limited by a CHECK/trigger to 20 rows at
-- the schema level — pruning is an application-layer decision (see
-- welcomeController.js's update()) specifically because a version's own
-- image_filename must be checked against what's still referenced (the
-- active config, and every other surviving version) before its file can
-- safely be deleted from disk; that's not expressible as a plain row-count
-- constraint.
--
-- image_filename here is a specific, permanent-until-pruned file, distinct
-- from every other version's own file (see welcome.js's saveUploadedMedia())
-- — this is the actual fix for prompt 0136's single-slot problem: that
-- version overwrote one shared file on every save, so an old version's own
-- reference silently rotted the moment a newer save replaced it.
CREATE TABLE welcome_versions (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  body_format TEXT NOT NULL CHECK (body_format IN ('plain', 'html')),
  image_filename TEXT,
  media_type TEXT CHECK (media_type IN ('image', 'video')),
  buttons TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_welcome_versions_created ON welcome_versions(created_at);
