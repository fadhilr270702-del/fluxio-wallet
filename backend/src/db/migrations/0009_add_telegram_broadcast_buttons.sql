-- Adds optional inline URL buttons to Telegram broadcasts. Stored as a JSON
-- array of {text, url} objects, one button per row of the eventual Telegram
-- inline keyboard (see backend/src/telegram/client.js's buildInlineKeyboard).
-- JSON-in-TEXT here, not a separate table: buttons are never queried/joined
-- independently of their parent broadcast, always read/written whole — the
-- same profile that already justifies audit_logs.metadata's JSON column.
-- A plain ADD COLUMN (no CHECK constraint involved), so this runs through
-- the default wrapped BEGIN/COMMIT path, no -- fluxio:manual-transaction needed.
ALTER TABLE telegram_broadcasts ADD COLUMN buttons TEXT NOT NULL DEFAULT '[]';
