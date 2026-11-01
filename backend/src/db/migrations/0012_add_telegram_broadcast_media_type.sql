-- Adds a media_type discriminator alongside the existing media_url/
-- media_file_id columns, needed now that media_file_id is shared by both
-- images (image-upload slice) and videos (this slice) — without this, a
-- stored file_id would be ambiguous about what to actually send it as.
--
-- Backfills every broadcast that already has media to 'image', since video
-- never existed as an option before this migration — this is what makes
-- media_type a reliable discriminator for every row, not just new ones.
-- See backend/src/telegram/formatting.js's resolveBroadcastMedia().
--
-- Two statements, one file (same pattern as migration 0004's multiple
-- CREATE TABLEs) — plain ADD COLUMN + UPDATE, no CHECK-widening or table
-- rebuild, so this runs through the default wrapped BEGIN/COMMIT path, no
-- -- fluxio:manual-transaction marker needed.
ALTER TABLE telegram_broadcasts ADD COLUMN media_type TEXT CHECK (media_type IN ('image', 'video'));
UPDATE telegram_broadcasts SET media_type = 'image' WHERE media_type IS NULL AND (media_file_id IS NOT NULL OR media_url IS NOT NULL);
