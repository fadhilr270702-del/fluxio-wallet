/**
 * Data access for the `welcome_message` table (prompt 0136). Prompt 0138
 * (dual-bot foundation) widened this from a true singleton (id=1, back when
 * there was only ever one bot) to one row per bot, keyed directly on
 * bot_id — no row exists for a given bot until the first time an admin
 * saves through the Welcome tab in that bot's own context.
 *
 * `mediaType` (prompt 0137) disambiguates whether `image_filename` — a name
 * kept from 0136 rather than renamed, see migration 0016's own comment —
 * currently holds an image or a video.
 */
import { lazyStatement } from '../client.js';

const findStmt = lazyStatement('SELECT * FROM welcome_message WHERE bot_id = ?');

const upsertStmt = lazyStatement(`
  INSERT INTO welcome_message (bot_id, body, body_format, image_filename, media_type, buttons, updated_by, created_at, updated_at)
  VALUES (@botId, @body, @bodyFormat, @imageFilename, @mediaType, @buttons, @updatedBy, @now, @now)
  ON CONFLICT(bot_id) DO UPDATE SET
    body = excluded.body,
    body_format = excluded.body_format,
    image_filename = excluded.image_filename,
    media_type = excluded.media_type,
    buttons = excluded.buttons,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at
`);

/** Returns the real saved config row for this bot, or null if no admin has ever saved one yet. */
export function getWelcomeMessageRow(botId) {
  return findStmt().get(botId) ?? null;
}

export function upsertWelcomeMessage({ botId, body, bodyFormat, imageFilename, mediaType, buttons, updatedBy }) {
  const now = new Date().toISOString();
  upsertStmt().run({
    botId,
    body,
    bodyFormat,
    imageFilename: imageFilename ?? null,
    mediaType: mediaType ?? null,
    buttons: JSON.stringify(buttons || []),
    updatedBy,
    now
  });
  return findStmt().get(botId);
}
