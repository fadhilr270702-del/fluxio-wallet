/**
 * Bot identity (prompt 0138, "dual bot foundation" — Stage A of a 3-stage
 * arc: A = data/runtime foundation only, B = an admin UI switcher, C =
 * server-side media storage + a "promote test content to official" flow,
 * both to follow in separate prompts). A plain string enum, not a `bots`
 * table — YAGNI: there are exactly two bots, known at deploy time, never
 * admin-creatable, so a table would only add a join everywhere for zero
 * real flexibility.
 */
export const BOT_IDS = Object.freeze(['test', 'official']);

/**
 * Every existing row in this database — every subscriber, broadcast,
 * welcome config/version, and API call made before this prompt — belongs
 * to the trial bot, which is what 'test' means. This is also the default
 * for every bot-context parameter this prompt adds, specifically so the
 * unmodified Stage-A admin UI (which never sends a bot param at all)
 * keeps behaving exactly as it did before this prompt existed.
 */
export const DEFAULT_BOT_ID = 'test';

export function isValidBotId(value) {
  return BOT_IDS.includes(value);
}

/**
 * The other bot, given one — only ever meaningful with exactly two bots
 * (see this file's own header on why that's a hardcoded assumption, not a
 * gap). Used by welcome's "Salin ke bot lain" (prompt 0141, Stage C): the
 * target is never chosen explicitly, it's always "whichever bot isn't the
 * one currently active".
 */
export function otherBotId(botId) {
  return BOT_IDS.find((id) => id !== botId);
}
