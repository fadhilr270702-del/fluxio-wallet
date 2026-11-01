/**
 * Resolves the bot-context parameter (prompt 0138, "dual bot foundation")
 * shared by both Telegram-facing admin controllers (broadcast + welcome) —
 * one implementation so the "missing = default, invalid = 400" contract
 * can't drift between the two.
 *
 * A missing/empty value deliberately resolves to DEFAULT_BOT_ID ('test'),
 * not a 400 — this is what keeps the current, unmodified Stage-A admin UI
 * (which never sends a `bot` param at all) behaving exactly as it did
 * before this prompt existed. An EXPLICITLY-sent value that isn't a real
 * bot id, however, is always a hard 400 (VALIDATION_ERROR is already used
 * elsewhere for body-shape problems — a distinct code here, INVALID_BOT_ID,
 * makes this specific failure easy to test for and to tell apart in logs)
 * — never silently coerced to the default, since a typo'd bot id silently
 * acting on the wrong bot's data would be far worse than a loud rejection.
 */
import { isValidBotId, DEFAULT_BOT_ID } from './botIds.js';
import { HttpError } from '../utils/httpError.js';

export function resolveBotId(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_BOT_ID;
  if (!isValidBotId(value)) {
    throw new HttpError(400, 'INVALID_BOT_ID', `Unknown bot id '${value}' — must be one of: test, official.`);
  }
  return value;
}
