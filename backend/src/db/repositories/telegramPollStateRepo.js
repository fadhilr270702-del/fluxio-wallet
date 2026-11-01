/**
 * Data access for `telegram_poll_state` — one row per bot (prompt 0138;
 * previously a true singleton at id=1, back when there was only ever one
 * bot) persisting that bot's own getUpdates long-poll offset across
 * restarts, so a restart doesn't reprocess or miss /start messages for
 * either bot. No row exists for a bot until its first setOffset() call;
 * getOffset() treats a missing row as offset 0.
 */
import { lazyStatement } from '../client.js';

const getStmt = lazyStatement('SELECT update_offset FROM telegram_poll_state WHERE bot_id = ?');
const setStmt = lazyStatement(`
  INSERT INTO telegram_poll_state (bot_id, update_offset, updated_at)
  VALUES (@botId, @offset, @now)
  ON CONFLICT(bot_id) DO UPDATE SET update_offset = excluded.update_offset, updated_at = excluded.updated_at
`);

export function getOffset(botId) {
  const row = getStmt().get(botId);
  return row ? row.update_offset : 0;
}

export function setOffset(botId, offset) {
  setStmt().run({ botId, offset, now: new Date().toISOString() });
}
