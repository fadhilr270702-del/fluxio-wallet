/**
 * Pure helpers for backend/scripts/fetchStartFixture.js (prompt 0250) — no
 * network, no file system, no config import, so they are unit-testable on
 * their own (backend/src/telegram/test/startFixtureHelpers.test.js).
 */

/** Every key whose value identifies a person or a chat by name. */
export const REDACTED_KEYS = ['first_name', 'last_name', 'username', 'title'];

/**
 * Deep redaction: every REDACTED_KEYS key at ANY depth becomes "redacted".
 * Deliberately a superset of the 0233 redaction (which only touched
 * message.from and message.chat): a group update can carry names in more
 * places than a private one — chat.title, sender_chat (an anonymous admin
 * posts as the group itself), reply_to_message, forward origins — and a
 * capture tool must never depend on having listed every such place.
 * Ids, chat.type, text, entities and dates are kept as received.
 */
export function redactDeep(value) {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = REDACTED_KEYS.includes(key) && inner != null ? 'redacted' : redactDeep(inner);
    }
    return out;
  }
  return value;
}

/** The two chat types this capture is for, mapped to their fixture file names. */
export const GROUP_FIXTURE_FILES = {
  group: 'start-group.json',
  supergroup: 'start-supergroup.json'
};

/**
 * From a raw getUpdates result, picks the LATEST /start message per group
 * chat type. The trigger mirrors poller.js exactly (text startsWith
 * '/start'), so "/start" and "/start@BotUsername" both count. Returns
 * `{ group: update | null, supergroup: update | null }`, NOT yet redacted.
 */
export function pickGroupStartUpdates(updates) {
  const picked = { group: null, supergroup: null };
  for (const update of updates ?? []) {
    const message = update?.message;
    const type = message?.chat?.type;
    if (!(type in picked)) continue;
    if (typeof message.text !== 'string' || !message.text.startsWith('/start')) continue;
    if (!picked[type] || update.update_id > picked[type].update_id) picked[type] = update;
  }
  return picked;
}

/** Bot token shape (digits, colon, 30+ token characters) — used to refuse writing a fixture that somehow contains one. */
export const BOT_TOKEN_SHAPE = /\d{8,}:[A-Za-z0-9_-]{30,}/;
